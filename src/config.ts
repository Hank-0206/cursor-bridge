import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProxyKey {
  key: string;
  label: string;
  createdAt: string;
  /**
   * 该令牌允许使用的 Cursor 模型 id（精确匹配解析后的 id）。
   * 缺省或空数组表示不限制。
   */
  allowedModels?: string[];
}

export interface AppConfig {
  /** 监听地址。0.0.0.0 = 局域网可访问；127.0.0.1 = 仅本机。 */
  host: string;
  port: number;
  /** Cursor API Key（crsr_...）。留空则依次回退到 CURSOR_API_KEY 环境变量、SDK 已保存的登录凭证。 */
  cursorApiKey: string;
  /** 发给局域网用户的访问令牌，请求必须携带其一。 */
  proxyKeys: ProxyKey[];
  /** 模型解析失败时的兜底 Cursor 模型 id。 */
  defaultModel: string;
  /** 请求模型名（小写精确匹配）到 Cursor 模型 id 的手动映射，优先级最高。 */
  modelOverrides: Record<string, string>;
  /** 是否把客户端声明的工具桥接给模型（Claude Code 需要开启）。 */
  allowClientTools: boolean;
  /** 性能拉满：未显式指定档位的请求，自动套用该模型最高的思考/上下文/速度组合。 */
  maximizeModels: boolean;
  /** 同时进行的模型运行数量上限，超出的请求排队。 */
  maxConcurrentRuns: number;
  /** 单次响应无输出的超时时间。 */
  requestTimeoutMs: number;
  /** 等待客户端回传工具结果的会话保活时间。 */
  sessionIdleMs: number;
  /** 管理面板登录用户名，写在 data/config.json。 */
  adminUsername: string;
  /** 管理面板登录密码，写在 data/config.json。 */
  adminPassword: string;
}

const DEFAULTS: AppConfig = {
  host: "0.0.0.0",
  port: 8318,
  cursorApiKey: "",
  proxyKeys: [],
  defaultModel: "auto",
  modelOverrides: {},
  allowClientTools: true,
  maximizeModels: false,
  maxConcurrentRuns: 4,
  requestTimeoutMs: 600_000,
  sessionIdleMs: 600_000,
  adminUsername: "admin",
  adminPassword: "admin",
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = path.join(rootDir, "data");
/** 空目录，作为 Cursor agent 的工作区（agent 已禁用文件/终端工具，此目录只是形式上的 cwd）。 */
export const sandboxDir = path.join(dataDir, "sandbox");
const configPath = path.join(dataDir, "config.json");

let config: AppConfig | null = null;

export function normalizeAllowedModels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  return ids.length > 0 ? ids : undefined;
}

export function generateProxyKey(label: string, allowedModels?: string[]): ProxyKey {
  const pk: ProxyKey = {
    key: `sk-cb-${randomBytes(24).toString("hex")}`,
    label,
    createdAt: new Date().toISOString(),
  };
  const allowed = normalizeAllowedModels(allowedModels);
  if (allowed) pk.allowedModels = allowed;
  return pk;
}

export function loadConfig(): AppConfig {
  if (config) return config;
  mkdirSync(sandboxDir, { recursive: true });
  let loaded: Partial<AppConfig> = {};
  if (existsSync(configPath)) {
    try {
      loaded = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      console.warn(`[cursor-bridge] 无法解析 ${configPath}，使用默认配置`);
    }
  }
  config = { ...DEFAULTS, ...loaded };
  config.adminUsername = String(config.adminUsername ?? "").trim() || DEFAULTS.adminUsername;
  config.adminPassword = String(config.adminPassword ?? "") || DEFAULTS.adminPassword;
  config.proxyKeys = config.proxyKeys.map((k) => {
    const allowedModels = normalizeAllowedModels(k.allowedModels);
    const next: ProxyKey = { key: k.key, label: k.label, createdAt: k.createdAt };
    if (allowedModels) next.allowedModels = allowedModels;
    return next;
  });
  if (config.proxyKeys.length === 0) {
    config.proxyKeys.push(generateProxyKey("default"));
  }
  saveConfig();
  return config;
}

export function getConfig(): AppConfig {
  return config ?? loadConfig();
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const c = getConfig();
  Object.assign(c, patch);
  saveConfig();
  return c;
}

function saveConfig(): void {
  if (!config) return;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

export type CursorKeySource = "config" | "env" | "sdk-login" | "none";

/** 实际用于调用 Cursor 的 key；undefined 表示交给 SDK 使用已保存的登录凭证。 */
export function effectiveCursorKey(): { key: string | undefined; source: CursorKeySource } {
  const c = getConfig();
  if (c.cursorApiKey.trim()) return { key: c.cursorApiKey.trim(), source: "config" };
  if (process.env.CURSOR_API_KEY?.trim()) return { key: process.env.CURSOR_API_KEY.trim(), source: "env" };
  if (existsSync(path.join(homedir(), ".cursor", "sdk", "auth.json"))) {
    return { key: undefined, source: "sdk-login" };
  }
  return { key: undefined, source: "none" };
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/** 空或缺省 = 不限制；否则返回小写 id 集合。 */
export function allowedModelSet(allowedModels?: string[]): Set<string> | null {
  const ids = normalizeAllowedModels(allowedModels);
  return ids ? new Set(ids.map((id) => id.toLowerCase())) : null;
}
