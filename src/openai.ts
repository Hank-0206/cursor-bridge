import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { executeBridgeRequest, type RequestMeta } from "./engine.js";
import { listModels } from "./models.js";
import {
  BridgeError,
  type BridgeImage,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeToolCall,
  type BridgeUsage,
  type Sink,
  type StopReason,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* 请求解析                                                             */
/* ------------------------------------------------------------------ */

const DATA_URL_RE = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i;

function parseContentParts(content: unknown): { text: string; images: BridgeImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: BridgeImage[] = [];
  for (const raw of content) {
    const part = raw as Record<string, any>;
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.type === "image_url") {
      const url: string = part.image_url?.url ?? "";
      const m = DATA_URL_RE.exec(url);
      if (m) images.push({ mimeType: m[1]!, data: m[2]! });
      else if (url) texts.push(`[image: ${url}]`);
    }
  }
  return { text: texts.join("\n"), images };
}

export function parseOpenAIRequest(body: Record<string, unknown>): BridgeRequest {
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) throw new BridgeError("invalid_request", "缺少 model 字段");
  if (!Array.isArray(body.messages)) throw new BridgeError("invalid_request", "缺少 messages 字段");

  const systems: string[] = [];
  const messages: BridgeMessage[] = [];

  for (const raw of body.messages as Array<Record<string, any>>) {
    const role = String(raw.role ?? "user");
    if (role === "system" || role === "developer") {
      systems.push(parseContentParts(raw.content).text);
      continue;
    }
    if (role === "tool") {
      const text = parseContentParts(raw.content).text;
      const result = {
        id: String(raw.tool_call_id ?? ""),
        text,
        images: [],
        isError: false,
      };
      // 连续的 tool 消息合并进同一条 user 消息，方便引擎做会话续接匹配。
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && last.toolResults.length > 0 && !last.text) {
        last.toolResults.push(result);
      } else {
        messages.push({ role: "user", text: "", images: [], toolCalls: [], toolResults: [result] });
      }
      continue;
    }
    if (role === "assistant") {
      const { text } = parseContentParts(raw.content);
      const toolCalls: BridgeToolCall[] = [];
      if (Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc?.function?.arguments ?? "{}");
          } catch {
            input = { _raw: tc?.function?.arguments };
          }
          toolCalls.push({ id: String(tc?.id ?? ""), name: String(tc?.function?.name ?? ""), input });
        }
      }
      messages.push({ role: "assistant", text, images: [], toolCalls, toolResults: [] });
      continue;
    }
    const { text, images } = parseContentParts(raw.content);
    messages.push({ role: "user", text, images, toolCalls: [], toolResults: [] });
  }

  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools as Array<Record<string, any>>) {
      if (raw.type !== "function" || !raw.function?.name) continue;
      tools.push({
        name: String(raw.function.name),
        description: typeof raw.function.description === "string" ? raw.function.description : undefined,
        inputSchema: (raw.function.parameters ?? undefined) as Record<string, unknown> | undefined,
      });
    }
  }

  const stop = body.stop;
  const maxTokens =
    typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : undefined;

  return {
    requestedModel: model,
    system: systems.join("\n\n"),
    messages,
    tools,
    maxTokens,
    stopSequences:
      typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop.filter((s): s is string => typeof s === "string") : [],
  };
}

/* ------------------------------------------------------------------ */
/* 错误输出                                                             */
/* ------------------------------------------------------------------ */

const ERROR_STATUS: Record<BridgeError["kind"], { status: number; type: string }> = {
  auth: { status: 401, type: "invalid_request_error" },
  rate_limit: { status: 429, type: "rate_limit_error" },
  invalid_request: { status: 400, type: "invalid_request_error" },
  overloaded: { status: 503, type: "server_error" },
  api: { status: 500, type: "server_error" },
};

export function openaiErrorBody(err: BridgeError): { status: number; body: unknown } {
  const m = ERROR_STATUS[err.kind];
  return { status: m.status, body: { error: { message: err.message, type: m.type, code: err.kind } } };
}

/* ------------------------------------------------------------------ */
/* Sink 实现                                                            */
/* ------------------------------------------------------------------ */

const FINISH_REASON: Record<StopReason, string> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
};

function chatId(): string {
  return `chatcmpl-cb${randomBytes(12).toString("hex")}`;
}

class OpenAIStreamSink implements Sink {
  private res: Response;
  private id = chatId();
  private created = Math.floor(Date.now() / 1000);
  private model: string;
  private includeUsage: boolean;
  private started = false;
  private sentRole = false;
  private done = false;
  private closed = false;
  private toolIndex = 0;
  private ping: NodeJS.Timeout | null = null;

  constructor(res: Response, model: string, includeUsage: boolean) {
    this.res = res;
    this.model = model;
    this.includeUsage = includeUsage;
    res.on("close", () => {
      this.closed = true;
      if (this.ping) clearInterval(this.ping);
    });
  }

  private write(data: unknown): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: BridgeUsage): void {
    const payload: Record<string, unknown> = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage && this.includeUsage) {
      payload.usage = {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      };
    }
    this.write(payload);
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
    this.ping = setInterval(() => {
      if (!this.closed && !this.res.writableEnded) this.res.write(": ping\n\n");
    }, 15_000);
    this.ping.unref();
  }

  private deltaBase(): Record<string, unknown> {
    if (this.sentRole) return {};
    this.sentRole = true;
    return { role: "assistant" };
  }

  textDelta(text: string): void {
    this.chunk({ ...this.deltaBase(), content: text }, null);
  }

  toolCalls(calls: BridgeToolCall[]): void {
    const tool_calls = calls.map((c) => ({
      index: this.toolIndex++,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
    }));
    this.chunk({ ...this.deltaBase(), tool_calls }, null);
  }

  finish(reason: StopReason, usage: BridgeUsage): void {
    if (this.done) return;
    this.done = true;
    this.chunk({}, FINISH_REASON[reason] ?? "stop", usage);
    if (!this.closed && !this.res.writableEnded) this.res.write("data: [DONE]\n\n");
    if (this.ping) clearInterval(this.ping);
    this.res.end();
  }

  error(err: BridgeError): void {
    if (this.done) return;
    this.done = true;
    if (this.ping) clearInterval(this.ping);
    if (!this.started) {
      const { status, body } = openaiErrorBody(err);
      this.res.status(status).json(body);
      return;
    }
    this.write({ error: { message: err.message, type: "server_error" } });
    this.res.end();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class OpenAIJsonSink implements Sink {
  private res: Response;
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
    const message: Record<string, unknown> = {
      role: "assistant",
      content: this.text || (this.calls.length > 0 ? null : ""),
    };
    if (this.calls.length > 0) {
      message.tool_calls = this.calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      }));
    }
    this.res.status(200).json({
      id: chatId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, message, finish_reason: FINISH_REASON[reason] ?? "stop" }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    });
  }

  error(err: BridgeError): void {
    if (this.done || this.closed) return;
    this.done = true;
    const { status, body } = openaiErrorBody(err);
    this.res.status(status).json(body);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                             */
/* ------------------------------------------------------------------ */

export async function handleChatCompletions(req: Request, res: Response, keyLabel: string): Promise<void> {
  let bridgeReq: BridgeRequest;
  const body = req.body as Record<string, unknown>;
  try {
    bridgeReq = parseOpenAIRequest(body);
  } catch (err) {
    const { status, body: eb } = openaiErrorBody(
      err instanceof BridgeError ? err : new BridgeError("invalid_request", String(err)),
    );
    res.status(status).json(eb);
    return;
  }
  const stream = Boolean(body.stream);
  const includeUsage = Boolean((body.stream_options as Record<string, unknown> | undefined)?.include_usage);
  const meta: RequestMeta = { api: "openai", keyLabel, stream };
  const sink: Sink = stream
    ? new OpenAIStreamSink(res, bridgeReq.requestedModel, includeUsage)
    : new OpenAIJsonSink(res, bridgeReq.requestedModel);
  await executeBridgeRequest(bridgeReq, sink, meta);
}

export async function handleListModels(_req: Request, res: Response): Promise<void> {
  try {
    const items = await listModels();
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: "list",
      data: items.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: "cursor",
        display_name: m.displayName,
        aliases: m.aliases ?? [],
      })),
    });
  } catch (err) {
    const { status, body } = openaiErrorBody(
      new BridgeError("api", `获取模型列表失败：${(err as Error).message ?? err}`),
    );
    res.status(status).json(body);
  }
}
