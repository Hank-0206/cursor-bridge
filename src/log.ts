/** 控制台日志 + 供管理面板展示的环形缓冲。绝不记录任何密钥内容。 */

import { recordUsage } from "./usage.js";

export interface RequestLogEntry {
  ts: string;
  api: "anthropic" | "openai" | "test";
  keyLabel: string;
  requestedModel: string;
  cursorModel: string;
  stream: boolean;
  status: "ok" | "tool_use" | "error";
  stopReason?: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  error?: string;
}

const MAX_REQUESTS = 200;
const requestLog: RequestLogEntry[] = [];

export function logRequest(entry: RequestLogEntry): void {
  requestLog.push(entry);
  if (requestLog.length > MAX_REQUESTS) requestLog.shift();
  recordUsage({
    keyLabel: entry.keyLabel,
    model: entry.cursorModel,
    status: entry.status,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    ts: entry.ts,
  });
  const tag = entry.status === "error" ? "ERR" : entry.status === "tool_use" ? "TOOL" : "OK ";
  console.log(
    `[req] ${tag} ${entry.api} key=${entry.keyLabel} model=${entry.requestedModel}->${entry.cursorModel} ` +
      `${entry.durationMs}ms in=${entry.inputTokens} out=${entry.outputTokens}` +
      (entry.error ? ` error=${entry.error}` : ""),
  );
}

export function recentRequests(): RequestLogEntry[] {
  return [...requestLog].reverse();
}

export function info(msg: string): void {
  console.log(`[cursor-bridge] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[cursor-bridge] ${msg}`);
}
