import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { type AuthedRequest } from "./auth.js";
import { executeBridgeRequest, type RequestMeta } from "./engine.js";
import {
  BridgeError,
  estimateRequestTokens,
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

interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blockText(content: unknown): { text: string; images: BridgeImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: BridgeImage[] = [];
  for (const raw of content) {
    const b = raw as AnthropicBlock;
    if (b.type === "text" && b.text) texts.push(b.text);
    else if (b.type === "image" && b.source) {
      if (b.source.type === "base64" && b.source.data) {
        images.push({ data: b.source.data, mimeType: b.source.media_type ?? "image/png" });
      } else if (b.source.url) {
        texts.push(`[image: ${b.source.url}]`);
      }
    } else if (b.type === "document") {
      texts.push("[document attachment omitted]");
    }
  }
  return { text: texts.join("\n"), images };
}

export function parseAnthropicRequest(body: Record<string, unknown>): BridgeRequest {
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) throw new BridgeError("invalid_request", "缺少 model 字段");
  if (!Array.isArray(body.messages)) throw new BridgeError("invalid_request", "缺少 messages 字段");

  let system = "";
  if (typeof body.system === "string") system = body.system;
  else if (Array.isArray(body.system)) system = blockText(body.system).text;

  const messages: BridgeMessage[] = [];
  for (const raw of body.messages as Array<Record<string, unknown>>) {
    const role = raw.role === "assistant" ? "assistant" : "user";
    const msg: BridgeMessage = { role, text: "", images: [], toolCalls: [], toolResults: [] };
    const content = raw.content;
    if (typeof content === "string") {
      msg.text = content;
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const rawBlock of content) {
        const b = rawBlock as AnthropicBlock;
        switch (b.type) {
          case "text":
            if (b.text) texts.push(b.text);
            break;
          case "image": {
            const { text, images } = blockText([b]);
            if (text) texts.push(text);
            msg.images.push(...images);
            break;
          }
          case "tool_use":
            msg.toolCalls.push({ id: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input ?? {} });
            break;
          case "tool_result": {
            const inner = blockText(b.content);
            msg.toolResults.push({
              id: String(b.tool_use_id ?? ""),
              text: inner.text,
              images: inner.images,
              isError: Boolean(b.is_error),
            });
            break;
          }
          case "thinking":
          case "redacted_thinking":
            break;
          default:
            if (b.text) texts.push(b.text);
        }
      }
      msg.text = texts.join("\n");
    }
    messages.push(msg);
  }

  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools as Array<Record<string, unknown>>) {
      const type = raw.type as string | undefined;
      if (type && type !== "custom") continue; // 服务端内置工具（web_search 等）不支持
      if (typeof raw.name !== "string" || !raw.input_schema) continue;
      tools.push({
        name: raw.name,
        description: typeof raw.description === "string" ? raw.description : undefined,
        inputSchema: raw.input_schema as Record<string, unknown>,
      });
    }
  }

  return {
    requestedModel: model,
    system,
    messages,
    tools,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    stopSequences: Array.isArray(body.stop_sequences)
      ? (body.stop_sequences as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* 错误输出                                                             */
/* ------------------------------------------------------------------ */

const ERROR_TYPE: Record<BridgeError["kind"], { status: number; type: string }> = {
  auth: { status: 401, type: "authentication_error" },
  forbidden: { status: 403, type: "permission_error" },
  rate_limit: { status: 429, type: "rate_limit_error" },
  invalid_request: { status: 400, type: "invalid_request_error" },
  overloaded: { status: 529, type: "overloaded_error" },
  api: { status: 500, type: "api_error" },
};

export function anthropicErrorBody(err: BridgeError): { status: number; body: unknown } {
  const m = ERROR_TYPE[err.kind];
  return { status: m.status, body: { type: "error", error: { type: m.type, message: err.message } } };
}

/* ------------------------------------------------------------------ */
/* Sink 实现                                                            */
/* ------------------------------------------------------------------ */

function newMessageId(): string {
  return `msg_cb_${randomBytes(12).toString("hex")}`;
}

function usageJson(u: BridgeUsage): Record<string, number> {
  return {
    input_tokens: u.inputTokens,
    cache_creation_input_tokens: u.cacheWriteTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    output_tokens: u.outputTokens,
  };
}

class AnthropicStreamSink implements Sink {
  private res: Response;
  private requestedModel: string;
  private messageId = newMessageId();
  private blockIndex = -1;
  private textBlockOpen = false;
  private started = false;
  private done = false;
  private closed = false;
  private ping: NodeJS.Timeout | null = null;
  private inputEstimate: number;

  constructor(res: Response, requestedModel: string, inputEstimate: number) {
    this.res = res;
    this.requestedModel = requestedModel;
    this.inputEstimate = inputEstimate;
    res.on("close", () => {
      this.closed = true;
      if (this.ping) clearInterval(this.ping);
    });
  }

  private event(name: string, data: unknown): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start(cursorModel: string): void {
    if (this.started) return;
    this.started = true;
    this.res.status(200);
    this.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-cache");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.flushHeaders();
    this.event("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: cursorModel || this.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputEstimate, output_tokens: 0 },
      },
    });
    this.event("ping", { type: "ping" });
    this.ping = setInterval(() => this.event("ping", { type: "ping" }), 15_000);
    this.ping.unref();
  }

  private openTextBlock(): void {
    if (this.textBlockOpen) return;
    this.blockIndex += 1;
    this.textBlockOpen = true;
    this.event("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeTextBlock(): void {
    if (!this.textBlockOpen) return;
    this.textBlockOpen = false;
    this.event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
  }

  textDelta(text: string): void {
    this.openTextBlock();
    this.event("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: "text_delta", text },
    });
  }

  toolCalls(calls: BridgeToolCall[]): void {
    this.closeTextBlock();
    for (const call of calls) {
      this.blockIndex += 1;
      this.event("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      });
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
      });
      this.event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    }
  }

  finish(reason: StopReason, usage: BridgeUsage): void {
    if (this.done) return;
    this.done = true;
    this.closeTextBlock();
    this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: usageJson(usage),
    });
    this.event("message_stop", { type: "message_stop" });
    if (this.ping) clearInterval(this.ping);
    this.res.end();
  }

  error(err: BridgeError): void {
    if (this.done) return;
    this.done = true;
    if (this.ping) clearInterval(this.ping);
    if (!this.started) {
      const { status, body } = anthropicErrorBody(err);
      this.res.status(status).json(body);
      return;
    }
    const { body } = anthropicErrorBody(err);
    this.event("error", body);
    this.res.end();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class AnthropicJsonSink implements Sink {
  private res: Response;
  private requestedModel: string;
  private cursorModel = "";
  private text = "";
  private calls: BridgeToolCall[] = [];
  private done = false;
  private closed = false;

  constructor(res: Response, requestedModel: string) {
    this.res = res;
    this.requestedModel = requestedModel;
    res.on("close", () => {
      this.closed = true;
    });
  }

  start(cursorModel: string): void {
    this.cursorModel = cursorModel;
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
    const content: unknown[] = [];
    if (this.text) content.push({ type: "text", text: this.text });
    for (const c of this.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
    this.res.status(200).json({
      id: newMessageId(),
      type: "message",
      role: "assistant",
      model: this.cursorModel || this.requestedModel,
      content,
      stop_reason: reason,
      stop_sequence: null,
      usage: usageJson(usage),
    });
  }

  error(err: BridgeError): void {
    if (this.done || this.closed) return;
    this.done = true;
    const { status, body } = anthropicErrorBody(err);
    this.res.status(status).json(body);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                             */
/* ------------------------------------------------------------------ */

export async function handleAnthropicMessages(req: Request, res: Response, keyLabel: string): Promise<void> {
  let bridgeReq: BridgeRequest;
  try {
    bridgeReq = parseAnthropicRequest(req.body as Record<string, unknown>);
  } catch (err) {
    const { status, body } = anthropicErrorBody(
      err instanceof BridgeError ? err : new BridgeError("invalid_request", String(err)),
    );
    res.status(status).json(body);
    return;
  }
  const stream = Boolean((req.body as Record<string, unknown>).stream);
  const meta: RequestMeta = {
    api: "anthropic",
    keyLabel,
    stream,
    allowedModels: (req as AuthedRequest).proxyKey?.allowedModels,
  };
  const sink: Sink = stream
    ? new AnthropicStreamSink(res, bridgeReq.requestedModel, estimateRequestTokens(bridgeReq))
    : new AnthropicJsonSink(res, bridgeReq.requestedModel);
  await executeBridgeRequest(bridgeReq, sink, meta);
}

export function handleCountTokens(req: Request, res: Response): void {
  try {
    const bridgeReq = parseAnthropicRequest(req.body as Record<string, unknown>);
    res.json({ input_tokens: estimateRequestTokens(bridgeReq) });
  } catch (err) {
    const { status, body } = anthropicErrorBody(
      err instanceof BridgeError ? err : new BridgeError("invalid_request", String(err)),
    );
    res.status(status).json(body);
  }
}
