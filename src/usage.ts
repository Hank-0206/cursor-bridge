import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

/** 按访问令牌累计的 token 用量，持久化到 data/usage.json，重启不丢失。 */

export interface ModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface KeyUsage {
  label: string;
  requests: number;
  ok: number;
  toolUse: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastUsed: string;
  models: Record<string, ModelUsage>;
}

export interface UsageStore {
  since: string;
  keys: Record<string, KeyUsage>;
}

export interface UsageEvent {
  keyLabel: string;
  /** 可以带参数后缀（claude-opus-5[...]），统计时会剥掉。 */
  model: string;
  status: "ok" | "tool_use" | "error";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ts: string;
}

const usagePath = path.join(dataDir, "usage.json");
const SAVE_INTERVAL_MS = 5_000;

let store: UsageStore = { since: new Date().toISOString(), keys: {} };
let dirty = false;

function load(): void {
  if (!existsSync(usagePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(usagePath, "utf8")) as UsageStore;
    if (parsed && typeof parsed === "object" && parsed.keys) store = parsed;
  } catch {
    console.warn(`[cursor-bridge] 无法解析 ${usagePath}，用量统计从零开始`);
  }
}
load();

export function recordUsage(ev: UsageEvent): void {
  const baseModel = ev.model.replace(/\[.*$/, "").trim() || "unknown";
  let k = store.keys[ev.keyLabel];
  if (!k) {
    k = {
      label: ev.keyLabel,
      requests: 0,
      ok: 0,
      toolUse: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastUsed: ev.ts,
      models: {},
    };
    store.keys[ev.keyLabel] = k;
  }
  k.requests += 1;
  if (ev.status === "ok") k.ok += 1;
  else if (ev.status === "tool_use") k.toolUse += 1;
  else k.errors += 1;
  k.inputTokens += ev.inputTokens;
  k.outputTokens += ev.outputTokens;
  k.cacheReadTokens += ev.cacheReadTokens;
  k.cacheWriteTokens += ev.cacheWriteTokens;
  if (ev.ts > k.lastUsed) k.lastUsed = ev.ts;

  let m = k.models[baseModel];
  if (!m) {
    m = { requests: 0, inputTokens: 0, outputTokens: 0 };
    k.models[baseModel] = m;
  }
  m.requests += 1;
  m.inputTokens += ev.inputTokens;
  m.outputTokens += ev.outputTokens;

  dirty = true;
}

export function flushUsage(): void {
  if (!dirty) return;
  dirty = false;
  try {
    writeFileSync(usagePath, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.warn(`[cursor-bridge] 写入用量统计失败: ${err}`);
  }
}

setInterval(flushUsage, SAVE_INTERVAL_MS).unref();

export function usageStats(): UsageStore {
  return store;
}

export function resetUsage(): void {
  store = { since: new Date().toISOString(), keys: {} };
  dirty = true;
  flushUsage();
}
