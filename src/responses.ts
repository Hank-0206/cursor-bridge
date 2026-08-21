import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Request, Response } from "express";
import { type AuthedRequest } from "./auth.js";
import { executeBridgeRequest, type RequestMeta } from "./engine.js";
import {
  BridgeError,
  estimateRequestTokens,
  type BridgeImage,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeTool,
  type BridgeToolCall,
  type BridgeUsage,
  type Sink,
  type StopReason,
} from "./types.js";

/**
 * OpenAI Responses API（/v1/responses）适配层。
 * Codex CLI / Codex Desktop 用的就是这个协议：input 为 response items 数组，
 * 工具调用走 function_call / function_call_output，流式是一套 response.* 事件。
 */

/* ------------------------------------------------------------------ */
/* 调试：留存最后一次原始请求，便于用真实 Codex 流量联调                    */
/* ------------------------------------------------------------------ */

let lastRawRequest: { ts: string; body: unknown } | null = null;
export function lastResponsesRequest(): { ts: string; body: unknown } | null {
  return lastRawRequest;
}

/* ------------------------------------------------------------------ */
/* 请求解析                                                             */
/* ------------------------------------------------------------------ */

const DATA_URL_RE = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i;
const COMPACTION_PREFIX = "cb1.";
const COMPACTION_MAX_BYTES = 8 * 1024 * 1024;

/** 使用当前访问令牌加密压缩摘要，供 Codex 作为不透明 compaction item 保存。 */
export function encodeBridgeCompaction(summary: string, secret: string): string {
  if (!secret) throw new BridgeError("auth", "缺少用于加密压缩上下文的访问令牌");
  const nonce = randomBytes(12);
  const key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const compressed = deflateRawSync(Buffer.from(summary, "utf8"));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  return COMPACTION_PREFIX + payload;
}

/** 解密由本代理生成的 Codex compaction item。 */
export function decodeBridgeCompaction(encryptedContent: string, secret: string): string {
  if (!encryptedContent.startsWith(COMPACTION_PREFIX)) {
    throw new BridgeError("invalid_request", "无法读取非本代理生成的压缩上下文，请新建 Codex 对话");
  }
  if (!secret) throw new BridgeError("auth", "缺少用于解密压缩上下文的访问令牌");
  try {
    const payload = Buffer.from(encryptedContent.slice(COMPACTION_PREFIX.length), "base64url");
    if (payload.length < 29) throw new Error("压缩数据长度不足");
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return inflateRawSync(compressed, { maxOutputLength: COMPACTION_MAX_BYTES }).toString("utf8");
  } catch {
    throw new BridgeError("invalid_request", "压缩上下文已损坏或访问令牌已变更，请新建 Codex 对话");
  }
}

function partsToText(content: unknown): { text: string; images: BridgeImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: BridgeImage[] = [];
  for (const raw of content) {
    const p = raw as Record<string, any>;
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
      if (typeof p.text === "string") texts.push(p.text);
    } else if (p.type === "input_image") {
      const url: string = p.image_url ?? p.image_url?.url ?? "";
      const m = DATA_URL_RE.exec(typeof url === "string" ? url : "");
      if (m) images.push({ mimeType: m[1]!, data: m[2]! });
      else if (typeof url === "string" && url) texts.push(`[image: ${url}]`);
    } else if (p.type === "refusal" && typeof p.refusal === "string") {
      texts.push(p.refusal);
    }
  }
  return { text: texts.join("\n"), images };
}

function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as Record<string, any>;
    if (typeof o.output === "string") return o.output;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.content)) return partsToText(o.content).text;
  }
  return JSON.stringify(output ?? "");
}

export function parseResponsesRequest(body: Record<string, unknown>, compactionSecret = ""): BridgeRequest {
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) throw new BridgeError("invalid_request", "缺少 model 字段");

  const systems: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systems.push(body.instructions);
  }

  const messages: BridgeMessage[] = [];
  const pushToolResult = (id: string, text: string, isError: boolean) => {
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && last.toolResults.length > 0 && !last.text) {
      last.toolResults.push({ id, text, images: [], isError });
    } else {
      messages.push({ role: "user", text: "", images: [], toolCalls: [], toolResults: [{ id, text, images: [], isError }] });
    }
  };

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", text: input, images: [], toolCalls: [], toolResults: [] });
  } else if (Array.isArray(input)) {
    for (const raw of input as Array<Record<string, any>>) {
      const type = raw.type ?? "message";
      switch (type) {
        case "message": {
          const role = raw.role === "assistant" ? "assistant" : raw.role === "system" || raw.role === "developer" ? "system" : "user";
          const { text, images } = partsToText(raw.content);
          if (role === "system") {
            if (text.trim()) systems.push(text);
          } else {
            messages.push({ role, text, images, toolCalls: [], toolResults: [] });
          }
          break;
        }
        case "function_call": {
          const call: BridgeToolCall = {
            id: String(raw.call_id ?? raw.id ?? ""),
            name: String(raw.name ?? ""),
            input: safeParse(raw.arguments),
          };
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant" && !last.text) {
            last.toolCalls.push(call);
          } else {
            messages.push({ role: "assistant", text: "", images: [], toolCalls: [call], toolResults: [] });
          }
          break;
        }
        case "custom_tool_call": {
          const call: BridgeToolCall = {
            id: String(raw.call_id ?? raw.id ?? ""),
            name: String(raw.name ?? ""),
            input: typeof raw.input === "string" ? raw.input : safeParse(raw.input ?? raw.arguments),
          };
          messages.push({ role: "assistant", text: "", images: [], toolCalls: [call], toolResults: [] });
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          pushToolResult(String(raw.call_id ?? ""), outputToText(raw.output), false);
          break;
        }
        case "compaction": {
          const encryptedContent = typeof raw.encrypted_content === "string" ? raw.encrypted_content : "";
          if (!encryptedContent) throw new BridgeError("invalid_request", "compaction item 缺少 encrypted_content");
          const summary = decodeBridgeCompaction(encryptedContent, compactionSecret);
          messages.push({
            role: "assistant",
            text: `<context_summary>\n${summary}\n</context_summary>`,
            images: [],
            toolCalls: [],
            toolResults: [],
          });
          break;
        }
        case "reasoning":
        case "item_reference":
          break;
        default:
          if (typeof raw.text === "string" && raw.text.trim()) {
            messages.push({ role: "user", text: raw.text, images: [], toolCalls: [], toolResults: [] });
          }
      }
    }
  }

  const tools: BridgeTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools as Array<Record<string, any>>) {
      // Responses 里工具可能平铺（{type:"function",name,...}）或嵌套（{type:"function",function:{...}}）
      if (raw.type === "function") {
        const fn = raw.function ?? raw;
        if (typeof fn.name === "string") {
          tools.push({
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : undefined,
            inputSchema: (fn.parameters ?? undefined) as Record<string, unknown> | undefined,
          });
        }
      } else if (raw.type === "custom" && typeof raw.name === "string") {
        // freeform / grammar 工具：无 JSON schema，作为接受单个 input 字符串的工具桥接
        tools.push({
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          inputSchema: { type: "object", properties: { input: { type: "string" } } },
        });
      }
      // 其它内置类型（web_search、local_shell 等）无法桥接，跳过
    }
  }

  const maxTokens = typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined;

  return {
    requestedModel: model,
    system: systems.join("\n\n"),
    messages,
    tools,
    maxTokens,
    stopSequences: [],
  };
}

function safeParse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return { _raw: v };
  }
}

/* ------------------------------------------------------------------ */
/* 错误输出                                                             */
/* ------------------------------------------------------------------ */

const ERROR_STATUS: Record<BridgeError["kind"], { status: number; code: string }> = {
  auth: { status: 401, code: "invalid_api_key" },
  forbidden: { status: 403, code: "model_not_allowed" },
  rate_limit: { status: 429, code: "rate_limit_exceeded" },
  invalid_request: { status: 400, code: "invalid_request_error" },
  overloaded: { status: 503, code: "server_error" },
  api: { status: 500, code: "server_error" },
};

export function responsesErrorBody(err: BridgeError): { status: number; body: unknown } {
  const m = ERROR_STATUS[err.kind];
  return { status: m.status, body: { error: { message: err.message, type: m.code, code: err.kind } } };
}

/* ------------------------------------------------------------------ */
/* 响应对象构造                                                          */
/* ------------------------------------------------------------------ */

type OutputItem = Record<string, unknown>;

/** 构造 Responses API 用量，并携带 Grok Build 识别的实时上下文字段。 */
export function responsesUsageJson(u: BridgeUsage): Record<string, unknown> {
  return {
    input_tokens: u.inputTokens,
    input_tokens_details: { cached_tokens: u.cacheReadTokens },
    output_tokens: u.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.inputTokens + u.outputTokens,
    // Grok Build 优先用这个字段识别模型当前真实上下文，避免把累计计费用量当成窗口占用。
    context_details: { input_tokens: u.inputTokens, output_tokens: u.outputTokens },
  };
}

function buildResponse(
  id: string,
  model: string,
  status: string,
  output: OutputItem[],
  usage: BridgeUsage | null,
  incompleteReason?: string,
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: "default",
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: usage ? responsesUsageJson(usage) : null,
    user: null,
    metadata: {},
  };
}

const FINISH_STATUS: Record<StopReason, { status: string; incomplete?: string }> = {
  end_turn: { status: "completed" },
  tool_use: { status: "completed" },
  stop_sequence: { status: "completed" },
  max_tokens: { status: "incomplete", incomplete: "max_output_tokens" },
};

function respId(): string {
  return `resp_cb${randomBytes(16).toString("hex")}`;
}
function msgId(): string {
  return `msg_cb${randomBytes(16).toString("hex")}`;
}
function fcId(): string {
  return `fc_cb${randomBytes(16).toString("hex")}`;
}
function cmpId(): string {
  return `cmp_cb${randomBytes(16).toString("hex")}`;
}

/** 按官方格式保留压缩输入中的用户消息。 */
function compactedUserItems(input: unknown): OutputItem[] {
  if (typeof input === "string") {
    return [{
      id: msgId(),
      type: "message",
      status: "completed",
      role: "user",
      content: [{ type: "input_text", text: input }],
    }];
  }
  if (!Array.isArray(input)) return [];
  return (input as Array<Record<string, unknown>>)
    .filter((item) => (item.type === undefined || item.type === "message") && item.role === "user")
    .map((item) => ({
      ...item,
      id: typeof item.id === "string" && item.id ? item.id : msgId(),
      type: "message",
      status: "completed",
      role: "user",
    }));
}

/** 构造 Codex / Responses API 兼容的压缩响应对象。 */
export function buildCompactedResponse(
  input: unknown,
  summary: string,
  secret: string,
  usage: BridgeUsage,
): Record<string, unknown> {
  return {
    id: respId(),
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      ...compactedUserItems(input),
      { id: cmpId(), type: "compaction", encrypted_content: encodeBridgeCompaction(summary, secret) },
    ],
    usage: responsesUsageJson(usage),
  };
}

/* ------------------------------------------------------------------ */
/* 流式 Sink                                                           */
/* ------------------------------------------------------------------ */

class ResponsesStreamSink implements Sink {
  private res: Response;
  private id = respId();
  private model: string;
  private seq = 0;
  private outputIndex = -1;
  private started = false;
  private done = false;
  private closed = false;
  private ping: NodeJS.Timeout | null = null;

  // 当前打开的文本 message item
  private textItemId: string | null = null;
  private textContent = "";
  // 已产出的完整 output items（供 response.completed 使用）
  private output: OutputItem[] = [];

  constructor(res: Response, model: string) {
    this.res = res;
    this.model = model;
    res.on("close", () => {
      this.closed = true;
      if (this.ping) clearInterval(this.ping);
    });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    if (this.closed || this.res.writableEnded) return;
    const data = { type, sequence_number: this.seq++, ...payload };
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start(cursorModel: string): void {
    if (this.started) return;
    this.started = true;
    if (cursorModel) this.model = cursorModel;
    this.res.status(200);
    this.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-cache");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.flushHeaders();
    const initial = buildResponse(this.id, this.model, "in_progress", [], null);
    this.emit("response.created", { response: initial });
    this.emit("response.in_progress", { response: initial });
    this.ping = setInterval(() => {
      if (!this.closed && !this.res.writableEnded) this.res.write(": ping\n\n");
    }, 15_000);
    this.ping.unref();
  }

  private openTextItem(): void {
    if (this.textItemId) return;
    this.textItemId = msgId();
    this.outputIndex += 1;
    this.emit("response.output_item.added", {
      output_index: this.outputIndex,
      item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.emit("response.content_part.added", {
      item_id: this.textItemId,
      output_index: this.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private closeTextItem(): void {
    if (!this.textItemId) return;
    const itemId = this.textItemId;
    const idx = this.outputIndex;
    this.emit("response.output_text.done", { item_id: itemId, output_index: idx, content_index: 0, text: this.textContent });
    this.emit("response.content_part.done", {
      item_id: itemId,
      output_index: idx,
      content_index: 0,
      part: { type: "output_text", text: this.textContent, annotations: [] },
    });
    const item: OutputItem = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: this.textContent, annotations: [] }],
    };
    this.emit("response.output_item.done", { output_index: idx, item });
    this.output.push(item);
    this.textItemId = null;
    this.textContent = "";
  }

  textDelta(text: string): void {
    if (this.closed) return;
    this.openTextItem();
    this.textContent += text;
    this.emit("response.output_text.delta", {
      item_id: this.textItemId,
      output_index: this.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  toolCalls(calls: BridgeToolCall[]): void {
    if (this.closed) return;
    this.closeTextItem();
    for (const call of calls) {
      const itemId = fcId();
      this.outputIndex += 1;
      const args = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
      this.emit("response.output_item.added", {
        output_index: this.outputIndex,
        item: { id: itemId, type: "function_call", status: "in_progress", call_id: call.id, name: call.name, arguments: "" },
      });
      this.emit("response.function_call_arguments.delta", { item_id: itemId, output_index: this.outputIndex, delta: args });
      this.emit("response.function_call_arguments.done", { item_id: itemId, output_index: this.outputIndex, arguments: args });
      const item: OutputItem = { id: itemId, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: args };
      this.emit("response.output_item.done", { output_index: this.outputIndex, item });
      this.output.push(item);
    }
  }

  finish(reason: StopReason, usage: BridgeUsage): void {
    if (this.done) return;
    this.done = true;
    this.closeTextItem();
    const map = FINISH_STATUS[reason] ?? { status: "completed" };
    const response = buildResponse(this.id, this.model, map.status, this.output, usage, map.incomplete);
    this.emit("response.completed", { response });
    if (this.ping) clearInterval(this.ping);
    this.res.end();
  }

  error(err: BridgeError): void {
    if (this.done) return;
    this.done = true;
    if (this.ping) clearInterval(this.ping);
    if (!this.started) {
      const { status, body } = responsesErrorBody(err);
      this.res.status(status).json(body);
      return;
    }
    const response = buildResponse(this.id, this.model, "failed", this.output, null);
    (response as Record<string, unknown>).error = { code: err.kind, message: err.message };
    this.emit("response.failed", { response });
    this.res.end();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/* ------------------------------------------------------------------ */
/* 非流式 Sink                                                         */
/* ------------------------------------------------------------------ */

class ResponsesJsonSink implements Sink {
  private res: Response;
  private id = respId();
  private model: string;
  private text = "";
  private calls: BridgeToolCall[] = [];
  private done = false;
  private closed = false;

  constructor(res: Response, model: string) {
    this.res = res;
    this.model = model;
    res.on("close", () => {
      this.closed = true;
    });
  }

  start(cursorModel: string): void {
    if (cursorModel) this.model = cursorModel;
  }

  textDelta(text: string): void {
    this.text += text;
  }

  toolCalls(calls: BridgeToolCall[]): void {
    this.calls.push(...calls);
  }

  finish(reason: StopReason, usage: BridgeUsage): void {
    if (this.done || this.closed) return;
    this.done = true;
    const output: OutputItem[] = [];
    if (this.text) {
      output.push({
        id: msgId(),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      });
    }
    for (const c of this.calls) {
      output.push({
        id: fcId(),
        type: "function_call",
        status: "completed",
        call_id: c.id,
        name: c.name,
        arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}),
      });
    }
    const map = FINISH_STATUS[reason] ?? { status: "completed" };
    this.res.status(200).json(buildResponse(this.id, this.model, map.status, output, usage, map.incomplete));
  }

  error(err: BridgeError): void {
    if (this.done || this.closed) return;
    this.done = true;
    const { status, body } = responsesErrorBody(err);
    this.res.status(status).json(body);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/** 收集 Cursor 模型生成的摘要并返回 Responses compaction 对象。 */
class ResponsesCompactSink implements Sink {
  private text = "";
  private failure: BridgeError | null = null;
  private done = false;
  private closed = false;

  constructor(
    private res: Response,
    private input: unknown,
    private secret: string,
  ) {
    res.on("close", () => {
      this.closed = true;
    });
  }

  start(_cursorModel: string): void {}

  textDelta(text: string): void {
    this.text += text;
  }

  toolCalls(_calls: BridgeToolCall[]): void {
    this.failure = new BridgeError("api", "上下文压缩期间模型意外发起了工具调用");
  }

  finish(reason: StopReason, usage: BridgeUsage): void {
    if (this.done || this.closed) return;
    if (this.failure) {
      this.error(this.failure);
      return;
    }
    if (reason === "max_tokens") {
      this.error(new BridgeError("api", "上下文压缩摘要超过最大长度"));
      return;
    }
    const summary = this.text.trim();
    if (!summary) {
      this.error(new BridgeError("api", "上游没有生成有效的上下文压缩摘要"));
      return;
    }
    this.done = true;
    this.res.status(200).json(buildCompactedResponse(this.input, summary, this.secret, usage));
  }

  error(err: BridgeError): void {
    if (this.done || this.closed) return;
    this.done = true;
    const { status, body } = responsesErrorBody(err);
    this.res.status(status).json(body);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                             */
/* ------------------------------------------------------------------ */

export async function handleResponses(req: Request, res: Response, keyLabel: string): Promise<void> {
  const body = req.body as Record<string, unknown>;
  lastRawRequest = { ts: new Date().toISOString(), body };
  let bridgeReq: BridgeRequest;
  try {
    bridgeReq = parseResponsesRequest(body, (req as AuthedRequest).proxyKey?.key ?? "");
  } catch (err) {
    const { status, body: eb } = responsesErrorBody(
      err instanceof BridgeError ? err : new BridgeError("invalid_request", String(err)),
    );
    res.status(status).json(eb);
    return;
  }
  const stream = Boolean(body.stream);
  const meta: RequestMeta = {
    api: "responses",
    keyLabel,
    stream,
    allowedModels: (req as AuthedRequest).proxyKey?.allowedModels,
  };
  const sink: Sink = stream
    ? new ResponsesStreamSink(res, bridgeReq.requestedModel)
    : new ResponsesJsonSink(res, bridgeReq.requestedModel);
  void estimateRequestTokens; // 估算在引擎内完成
  await executeBridgeRequest(bridgeReq, sink, meta);
}

/** 处理 Codex 调用的 Responses 上下文压缩端点。 */
export async function handleResponsesCompact(req: Request, res: Response, keyLabel: string): Promise<void> {
  const body = req.body as Record<string, unknown>;
  lastRawRequest = { ts: new Date().toISOString(), body };
  const secret = (req as AuthedRequest).proxyKey?.key ?? "";
  let bridgeReq: BridgeRequest;
  try {
    bridgeReq = parseResponsesRequest(body, secret);
  } catch (err) {
    const { status, body: eb } = responsesErrorBody(
      err instanceof BridgeError ? err : new BridgeError("invalid_request", String(err)),
    );
    res.status(status).json(eb);
    return;
  }

  bridgeReq.operation = "compact";
  bridgeReq.tools = [];
  bridgeReq.stopSequences = [];
  bridgeReq.maxTokens = 16_384;
  const meta: RequestMeta = {
    api: "responses",
    keyLabel,
    stream: false,
    allowedModels: (req as AuthedRequest).proxyKey?.allowedModels,
  };
  const sink: Sink = new ResponsesCompactSink(res, body.input, secret);
  await executeBridgeRequest(bridgeReq, sink, meta);
}
