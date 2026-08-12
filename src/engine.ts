import { randomBytes } from "node:crypto";
import {
  Agent,
  type AgentOptions,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKCustomToolContent,
  type SDKCustomToolResult,
  type TokenUsage,
} from "@cursor/sdk";
import { effectiveCursorKey, getConfig, sandboxDir } from "./config.js";
import { info, logRequest, warn } from "./log.js";
import { resolveModel } from "./models.js";
import { renderPrompt } from "./prompt.js";
import {
  BridgeError,
  estimateRequestTokens,
  estimateTokens,
  type BridgeRequest,
  type BridgeToolCall,
  type BridgeToolResult,
  type BridgeUsage,
  type Sink,
  type StopReason,
} from "./types.js";

const BATCH_MS = 250;
const WATCHDOG_MS = 15_000;
const MAX_QUEUE = 16;

/* ------------------------------------------------------------------ */
/* 并发信号量                                                            */
/* ------------------------------------------------------------------ */

let running = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  const max = getConfig().maxConcurrentRuns;
  if (running < max) {
    running += 1;
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    throw new BridgeError("overloaded", "代理繁忙：等待队列已满，请稍后重试");
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  running += 1;
}

function releaseSlot(): void {
  running = Math.max(0, running - 1);
  const next = queue.shift();
  if (next) next();
}

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

type BufferedEvent =
  | { type: "text"; text: string }
  | { type: "toolCalls"; calls: BridgeToolCall[] };

interface PendingTool {
  name: string;
  resolve: (result: SDKCustomToolResult) => void;
}

interface ResponseCtx {
  sink: Sink;
  maxTokens?: number;
  stopSequences: string[];
  emittedChars: number;
  tail: string;
  inputTokensEstimate: number;
  startedAt: number;
  meta: RequestMeta;
  finished: boolean;
}

export interface RequestMeta {
  api: "anthropic" | "openai" | "test";
  keyLabel: string;
  stream: boolean;
}

class Session {
  readonly id = `sess_${randomBytes(8).toString("hex")}`;
  agent: SDKAgent | null = null;
  run: Run | null = null;
  cursorModel = "";
  requestedModel = "";
  holdsSlot = false;
  closed = false;
  lastActivity = Date.now();
  usage: TokenUsage | null = null;
  pending = new Map<string, PendingTool>();
  batch: BridgeToolCall[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private buffer: BufferedEvent[] = [];
  response: ResponseCtx | null = null;

  attach(ctx: ResponseCtx): void {
    this.response = ctx;
    this.lastActivity = Date.now();
    ctx.sink.start(this.cursorModel);
    for (const ev of this.buffer.splice(0)) {
      if (ev.type === "text") this.emitText(ev.text);
      else this.emitToolCalls(ev.calls);
    }
  }

  /** 文本增量：应用 stop_sequences / max_tokens 限制后转发。 */
  emitText(text: string): void {
    this.lastActivity = Date.now();
    const ctx = this.response;
    if (!ctx || ctx.finished) {
      this.buffer.push({ type: "text", text });
      return;
    }
    if (ctx.sink.isClosed()) {
      void abortSession(this, "客户端断开连接");
      return;
    }
    let chunk = text;

    if (ctx.stopSequences.length > 0) {
      const window = ctx.tail + chunk;
      let cutAt = -1;
      let matched = "";
      for (const seq of ctx.stopSequences) {
        const idx = window.indexOf(seq);
        if (idx >= 0 && (cutAt === -1 || idx < cutAt)) {
          cutAt = idx;
          matched = seq;
        }
      }
      if (cutAt >= 0) {
        const keep = window.slice(0, cutAt).slice(ctx.tail.length ? ctx.tail.length : 0);
        if (keep) {
          ctx.emittedChars += keep.length;
          ctx.sink.textDelta(keep);
        }
        this.finishResponse("stop_sequence");
        void abortSession(this, `命中停止序列 ${JSON.stringify(matched)}`);
        return;
      }
      const maxSeqLen = Math.max(...ctx.stopSequences.map((s) => s.length));
      ctx.tail = window.slice(Math.max(0, window.length - (maxSeqLen - 1)));
    }

    ctx.emittedChars += chunk.length;
    ctx.sink.textDelta(chunk);

    if (ctx.maxTokens && ctx.emittedChars / 4 >= ctx.maxTokens) {
      this.finishResponse("max_tokens");
      void abortSession(this, "达到 max_tokens 上限");
    }
  }

  emitToolCalls(calls: BridgeToolCall[]): void {
    this.lastActivity = Date.now();
    const ctx = this.response;
    if (!ctx || ctx.finished) {
      this.buffer.push({ type: "toolCalls", calls });
      return;
    }
    ctx.sink.toolCalls(calls);
    this.finishResponse("tool_use");
  }

  /** 结束当前 HTTP 响应（会话本身可能继续存活等待工具结果）。 */
  finishResponse(reason: StopReason): void {
    const ctx = this.response;
    if (!ctx || ctx.finished) return;
    ctx.finished = true;
    const usage = this.buildUsage(ctx);
    ctx.sink.finish(reason, usage);
    logRequest({
      ts: new Date().toISOString(),
      api: ctx.meta.api,
      keyLabel: ctx.meta.keyLabel,
      requestedModel: this.requestedModel,
      cursorModel: this.cursorModel,
      stream: ctx.meta.stream,
      status: reason === "tool_use" ? "tool_use" : "ok",
      stopReason: reason,
      durationMs: Date.now() - ctx.startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    this.response = null;
  }

  failResponse(err: BridgeError): void {
    const ctx = this.response;
    if (!ctx || ctx.finished) return;
    ctx.finished = true;
    ctx.sink.error(err);
    logRequest({
      ts: new Date().toISOString(),
      api: ctx.meta.api,
      keyLabel: ctx.meta.keyLabel,
      requestedModel: this.requestedModel,
      cursorModel: this.cursorModel,
      stream: ctx.meta.stream,
      status: "error",
      durationMs: Date.now() - ctx.startedAt,
      inputTokens: 0,
      outputTokens: 0,
      error: err.message,
    });
    this.response = null;
  }

  private buildUsage(ctx: ResponseCtx): BridgeUsage {
    if (this.usage) {
      return {
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        cacheReadTokens: this.usage.cacheReadTokens,
        cacheWriteTokens: this.usage.cacheWriteTokens,
        estimated: false,
      };
    }
    return {
      inputTokens: ctx.inputTokensEstimate,
      outputTokens: Math.ceil(ctx.emittedChars / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimated: true,
    };
  }

  /** 模型通过 customTools 发起调用时进入这里；返回的 Promise 在客户端回传结果后才 resolve。 */
  onToolInvoked(name: string, args: Record<string, unknown>): Promise<SDKCustomToolResult> {
    this.lastActivity = Date.now();
    const id = `toolu_cb_${randomBytes(12).toString("hex")}`;
    const promise = new Promise<SDKCustomToolResult>((resolve) => {
      this.pending.set(id, { name, resolve });
    });
    this.batch.push({ id, name, input: args });
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_MS);
    return promise;
  }

  private flushBatch(): void {
    this.batchTimer = null;
    if (this.batch.length === 0) return;
    const calls = this.batch.splice(0);
    for (const call of calls) pendingIndex.set(call.id, this);
    this.emitToolCalls(calls);
    // 会话进入"停车"状态等待工具结果，让出并发额度。
    if (this.holdsSlot) {
      this.holdsSlot = false;
      releaseSlot();
    }
  }

  resolveTool(result: BridgeToolResult): boolean {
    const pending = this.pending.get(result.id);
    if (!pending) return false;
    this.pending.delete(result.id);
    pendingIndex.delete(result.id);
    const content: SDKCustomToolContent[] = [];
    content.push({ type: "text", text: result.text || "(empty result)" });
    for (const img of result.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    pending.resolve({ content, isError: result.isError || undefined });
    this.lastActivity = Date.now();
    return true;
  }
}

const sessions = new Set<Session>();
/** tool_use id -> 等待该结果的会话。 */
const pendingIndex = new Map<string, Session>();

export function sessionStats(): { active: number; parked: number; queued: number } {
  let parked = 0;
  for (const s of sessions) if (s.pending.size > 0) parked += 1;
  return { active: sessions.size, parked, queued: queue.length };
}

async function abortSession(session: Session, reason: string): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session);
  for (const [id, pending] of session.pending) {
    pendingIndex.delete(id);
    pending.resolve({
      content: [{ type: "text", text: `(bridge) tool call aborted: ${reason}` }],
      isError: true,
    });
  }
  session.pending.clear();
  if (session.holdsSlot) {
    session.holdsSlot = false;
    releaseSlot();
  }
  try {
    if (session.run && session.run.supports("cancel") && session.run.status === "running") {
      await session.run.cancel();
    }
  } catch {
    /* 忽略取消失败 */
  }
  try {
    await session.agent?.[Symbol.asyncDispose]();
  } catch {
    /* 忽略清理失败 */
  }
}

/* ------------------------------------------------------------------ */
/* 看门狗：响应超时与停车会话过期                                          */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const config = getConfig();
  const now = Date.now();
  for (const s of [...sessions]) {
    const idle = now - s.lastActivity;
    if (s.response && !s.response.finished && idle > config.requestTimeoutMs) {
      s.failResponse(new BridgeError("api", "上游长时间无输出，请求超时"));
      void abortSession(s, "响应超时");
    } else if (!s.response && idle > config.sessionIdleMs) {
      void abortSession(s, "等待工具结果超时");
    }
  }
}, WATCHDOG_MS).unref();

/* ------------------------------------------------------------------ */
/* 错误转换                                                             */
/* ------------------------------------------------------------------ */

function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  const e = err as { status?: number; code?: string; message?: string };
  const msg = e?.message || String(err);
  const status = e?.status;
  if (status === 401 || /unauthorized|invalid (user )?api key|not logged in|api key is required/i.test(msg)) {
    return new BridgeError("auth", `Cursor 鉴权失败：${msg}（请在管理面板检查 Cursor API Key）`);
  }
  if (status === 429) return new BridgeError("rate_limit", `Cursor 限流：${msg}`);
  if (status === 400 || status === 404) return new BridgeError("invalid_request", msg);
  if (status === 503 || status === 504) return new BridgeError("overloaded", `Cursor 服务不可用：${msg}`);
  return new BridgeError("api", msg);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 处理一次协议无关的对话请求。
 * 1. 若请求尾部的 tool_result 能匹配到停车中的会话 → 续接原 run；
 * 2. 否则创建新 agent，把完整历史渲染成提示词重放。
 */
export async function executeBridgeRequest(req: BridgeRequest, sink: Sink, meta: RequestMeta): Promise<void> {
  if (process.env.CB_MOCK) {
    return runMock(req, sink, meta);
  }

  const continuation = findContinuation(req);
  if (continuation) {
    resumeSession(continuation.session, continuation.results, req, sink, meta);
    return;
  }
  await startSession(req, sink, meta);
}

function findContinuation(req: BridgeRequest): { session: Session; results: BridgeToolResult[] } | null {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== "user" || last.toolResults.length === 0) return null;
  // 携带了额外的用户文本时说明对话内容有新增，历史与 agent 内部状态可能不一致，走重放。
  if (last.text.trim()) return null;
  let session: Session | null = null;
  for (const r of last.toolResults) {
    const s = pendingIndex.get(r.id);
    if (!s || (session && s !== session)) return null;
    session = s;
  }
  if (!session || session.closed || session.response) return null;
  return { session, results: last.toolResults };
}

function resumeSession(
  session: Session,
  results: BridgeToolResult[],
  req: BridgeRequest,
  sink: Sink,
  meta: RequestMeta,
): void {
  session.attach({
    sink,
    maxTokens: req.maxTokens,
    stopSequences: req.stopSequences,
    emittedChars: 0,
    tail: "",
    inputTokensEstimate: estimateRequestTokens(req),
    startedAt: Date.now(),
    meta,
    finished: false,
  });
  for (const r of results) {
    if (!session.resolveTool(r)) {
      warn(`会话 ${session.id} 中找不到 tool_use ${r.id} 的挂起记录`);
    }
  }
}

async function startSession(req: BridgeRequest, sink: Sink, meta: RequestMeta): Promise<void> {
  const config = getConfig();
  const useTools = config.allowClientTools && req.tools.length > 0;
  const session = new Session();
  session.requestedModel = req.requestedModel;

  try {
    const resolved = await resolveModel(req.requestedModel);
    session.cursorModel = resolved.id;

    await acquireSlot();
    session.holdsSlot = true;
    sessions.add(session);

    session.attach({
      sink,
      maxTokens: req.maxTokens,
      stopSequences: req.stopSequences,
      emittedChars: 0,
      tail: "",
      inputTokensEstimate: estimateRequestTokens(req),
      startedAt: Date.now(),
      meta,
      finished: false,
    });

    const customTools: Record<string, SDKCustomTool> = {};
    if (useTools) {
      for (const tool of req.tools) {
        customTools[tool.name] = {
          description: tool.description,
          inputSchema: tool.inputSchema as SDKCustomTool["inputSchema"],
          execute: (args) => session.onToolInvoked(tool.name, args as Record<string, unknown>),
        };
      }
    }

    const { key } = effectiveCursorKey();
    const options: AgentOptions = {
      ...(key ? { apiKey: key } : {}),
      model: { id: session.cursorModel },
      tools: useTools ? ["mcp"] : [],
      name: `cursor-bridge ${session.id}`,
      local: {
        cwd: sandboxDir,
        settingSources: [],
        ...(useTools ? { customTools } : {}),
      },
    };

    session.agent = await Agent.create(options);
    const { text, images } = renderPrompt(req);
    const run = await session.agent.send(
      images.length > 0
        ? { text, images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })) }
        : text,
    );
    session.run = run;
    void consumeRun(session, run);
  } catch (err) {
    session.failResponse(toBridgeError(err));
    await abortSession(session, "启动失败");
  }
}

async function consumeRun(session: Session, run: Run): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (session.closed) break;
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) session.emitText(block.text);
        }
      } else if (event.type === "usage") {
        session.usage = event.usage;
        session.lastActivity = Date.now();
      } else if (event.type === "status" || event.type === "thinking" || event.type === "tool_call") {
        session.lastActivity = Date.now();
      }
    }
    if (session.closed) return;
    const result = await run.wait();
    if (result.usage) session.usage = result.usage;
    if (result.status === "finished") {
      session.finishResponse("end_turn");
    } else if (result.status === "cancelled") {
      session.failResponse(new BridgeError("api", "运行被取消"));
    } else {
      session.failResponse(
        toBridgeError({
          message: result.error?.message ?? "Cursor 运行失败",
          code: result.error?.code,
        }),
      );
    }
  } catch (err) {
    if (!session.closed) session.failResponse(toBridgeError(err));
  } finally {
    if (!session.closed) {
      session.closed = true;
      sessions.delete(session);
      if (session.holdsSlot) {
        session.holdsSlot = false;
        releaseSlot();
      }
      for (const [id] of session.pending) pendingIndex.delete(id);
      session.pending.clear();
      try {
        await session.agent?.[Symbol.asyncDispose]();
      } catch {
        /* 忽略 */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mock 模式：CB_MOCK=1 文本回复；CB_MOCK=tool 时先发起一次工具调用            */
/* ------------------------------------------------------------------ */

async function runMock(req: BridgeRequest, sink: Sink, meta: RequestMeta): Promise<void> {
  const startedAt = Date.now();
  sink.start("mock-model");
  const last = req.messages[req.messages.length - 1];
  const usage: BridgeUsage = {
    inputTokens: estimateRequestTokens(req),
    outputTokens: 24,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: true,
  };
  const finish = (reason: StopReason, status: "ok" | "tool_use") => {
    sink.finish(reason, usage);
    logRequest({
      ts: new Date().toISOString(),
      api: meta.api,
      keyLabel: meta.keyLabel,
      requestedModel: req.requestedModel,
      cursorModel: "mock-model",
      stream: meta.stream,
      status,
      stopReason: reason,
      durationMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  };

  if (process.env.CB_MOCK === "tool" && req.tools.length > 0 && last && last.toolResults.length === 0) {
    const tool = req.tools[0]!;
    sink.toolCalls([
      { id: `toolu_cb_mock_${randomBytes(6).toString("hex")}`, name: tool.name, input: { mock: true } },
    ]);
    finish("tool_use", "tool_use");
    return;
  }

  const reply =
    last && last.toolResults.length > 0
      ? `已收到 ${last.toolResults.length} 个工具结果（mock 模式）。`
      : `这是 cursor-bridge 的 mock 回复。收到的最后一条消息：${(last?.text ?? "").slice(0, 80)}`;
  for (const piece of reply.match(/.{1,8}/gs) ?? []) {
    if (sink.isClosed()) return;
    sink.textDelta(piece);
    await new Promise((r) => setTimeout(r, 30));
  }
  finish("end_turn", "ok");
}

info("引擎已初始化");
