/** 内部统一的请求/事件表示：Anthropic 与 OpenAI 两种协议都先转换成这些结构再交给引擎。 */

export interface BridgeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface BridgeToolCall {
  /** 由代理生成的调用 id（回传给客户端，同时用于会话续接匹配）。 */
  id: string;
  name: string;
  input: unknown;
}

export interface BridgeToolResultContent {
  text: string;
  images: BridgeImage[];
  isError: boolean;
}

export interface BridgeToolResult extends BridgeToolResultContent {
  /** 对应之前返回给客户端的 tool_use id。 */
  id: string;
}

export interface BridgeImage {
  /** base64 编码数据。 */
  data: string;
  mimeType: string;
}

export interface BridgeMessage {
  role: "user" | "assistant";
  text: string;
  images: BridgeImage[];
  /** assistant 消息中出现过的工具调用。 */
  toolCalls: BridgeToolCall[];
  /** user 消息中携带的工具执行结果。 */
  toolResults: BridgeToolResult[];
}

export interface BridgeRequest {
  requestedModel: string;
  system: string;
  messages: BridgeMessage[];
  tools: BridgeTool[];
  maxTokens?: number;
  stopSequences: string[];
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence";

export interface BridgeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** true 表示 token 数是估算值（后端没有上报真实用量）。 */
  estimated: boolean;
}

/**
 * 协议适配层实现的输出端。引擎只往 Sink 里推事件，
 * 由 anthropic.ts / openai.ts 负责翻译成各自的 SSE / JSON 格式。
 */
export interface Sink {
  /** 解析出的 Cursor 模型 id 确定后调用一次。 */
  start(cursorModel: string): void;
  textDelta(text: string): void;
  /** 模型发起了工具调用；随后引擎会立即以 tool_use 结束本次响应。 */
  toolCalls(calls: BridgeToolCall[]): void;
  finish(reason: StopReason, usage: BridgeUsage): void;
  /** 执行中出错（可能发生在流中途）。 */
  error(err: BridgeError): void;
  /** 客户端是否已断开。 */
  isClosed(): boolean;
}

export type BridgeErrorKind =
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "overloaded"
  | "api";

export class BridgeError extends Error {
  kind: BridgeErrorKind;
  constructor(kind: BridgeErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 粗略的 token 估算：约 4 字符 = 1 token，图片按固定值计。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateRequestTokens(req: BridgeRequest): number {
  let total = estimateTokens(req.system);
  for (const m of req.messages) {
    total += estimateTokens(m.text) + m.images.length * 1500;
    for (const c of m.toolCalls) total += estimateTokens(JSON.stringify(c.input ?? {}) + c.name);
    for (const r of m.toolResults) total += estimateTokens(r.text) + r.images.length * 1500;
  }
  total += estimateTokens(JSON.stringify(req.tools));
  return total;
}
