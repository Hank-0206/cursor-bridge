import { networkInterfaces } from "node:os";
import { Cursor } from "@cursor/sdk";
import { Router, type Request, type Response } from "express";
import {
  effectiveCursorKey,
  generateProxyKey,
  getConfig,
  maskKey,
  updateConfig,
  type AppConfig,
} from "./config.js";
import { executeBridgeRequest, sessionStats } from "./engine.js";
import { recentRequests } from "./log.js";
import { cachedModels, invalidateModelCache, listModels } from "./models.js";
import { BridgeError, type BridgeToolCall, type BridgeUsage, type Sink, type StopReason } from "./types.js";

const startedAt = Date.now();

export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const [, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) result.push(a.address);
    }
  }
  return result;
}

export const adminRouter = Router();

adminRouter.get("/status", (_req: Request, res: Response) => {
  const config = getConfig();
  const { key, source } = effectiveCursorKey();
  const models = cachedModels();
  res.json({
    version: "0.1.0",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    host: config.host,
    port: config.port,
    lanAddresses: lanAddresses(),
    mock: Boolean(process.env.CB_MOCK),
    cursorKey: {
      source,
      preview: key ? maskKey(key) : null,
      configured: source !== "none",
    },
    models: models ? { count: models.items.length, fetchedAt: models.fetchedAt } : null,
    sessions: sessionStats(),
    config: {
      defaultModel: config.defaultModel,
      allowClientTools: config.allowClientTools,
      maximizeModels: config.maximizeModels,
      maxConcurrentRuns: config.maxConcurrentRuns,
      requestTimeoutMs: config.requestTimeoutMs,
      sessionIdleMs: config.sessionIdleMs,
      modelOverrides: config.modelOverrides,
    },
  });
});

adminRouter.post("/cursor-key", async (req: Request, res: Response) => {
  const key = String((req.body as Record<string, unknown>)?.key ?? "").trim();
  if (!key) {
    res.status(400).json({ ok: false, error: "key 不能为空" });
    return;
  }
  try {
    const user = await Cursor.me({ apiKey: key });
    updateConfig({ cursorApiKey: key });
    invalidateModelCache();
    const models = await listModels(true).catch(() => []);
    res.json({
      ok: true,
      user: { apiKeyName: user.apiKeyName, email: user.userEmail ?? null },
      modelCount: models.length,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: `Key 验证失败：${(err as Error).message}` });
  }
});

adminRouter.delete("/cursor-key", (_req: Request, res: Response) => {
  updateConfig({ cursorApiKey: "" });
  invalidateModelCache();
  res.json({ ok: true });
});

adminRouter.post("/verify", async (_req: Request, res: Response) => {
  const { key, source } = effectiveCursorKey();
  if (source === "none") {
    res.json({ ok: false, error: "尚未配置 Cursor API Key" });
    return;
  }
  try {
    const user = await Cursor.me(key ? { apiKey: key } : undefined);
    const models = await listModels(true);
    res.json({
      ok: true,
      source,
      user: { apiKeyName: user.apiKeyName, email: user.userEmail ?? null },
      modelCount: models.length,
    });
  } catch (err) {
    res.json({ ok: false, source, error: (err as Error).message });
  }
});

let loginInProgress = false;
adminRouter.post("/login", async (_req: Request, res: Response) => {
  if (loginInProgress) {
    res.status(409).json({ ok: false, error: "已有一个登录流程在进行中" });
    return;
  }
  loginInProgress = true;
  try {
    await Cursor.auth.login();
    invalidateModelCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    loginInProgress = false;
  }
});

adminRouter.get("/models", async (req: Request, res: Response) => {
  try {
    const items = await listModels(req.query.refresh === "1");
    res.json({
      ok: true,
      models: items.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description ?? null,
        aliases: m.aliases ?? [],
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.get("/keys", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    keys: getConfig().proxyKeys.map((k) => ({ key: k.key, label: k.label, createdAt: k.createdAt })),
  });
});

adminRouter.post("/keys", (req: Request, res: Response) => {
  const label = String((req.body as Record<string, unknown>)?.label ?? "").trim() || `key-${Date.now()}`;
  const config = getConfig();
  const pk = generateProxyKey(label);
  updateConfig({ proxyKeys: [...config.proxyKeys, pk] });
  res.json({ ok: true, key: pk });
});

adminRouter.delete("/keys/:key", (req: Request, res: Response) => {
  const config = getConfig();
  const remaining = config.proxyKeys.filter((k) => k.key !== req.params.key);
  if (remaining.length === config.proxyKeys.length) {
    res.status(404).json({ ok: false, error: "未找到该令牌" });
    return;
  }
  if (remaining.length === 0) {
    res.status(400).json({ ok: false, error: "至少保留一个访问令牌" });
    return;
  }
  updateConfig({ proxyKeys: remaining });
  res.json({ ok: true });
});

const PATCHABLE: Array<keyof AppConfig> = [
  "defaultModel",
  "modelOverrides",
  "allowClientTools",
  "maximizeModels",
  "maxConcurrentRuns",
  "requestTimeoutMs",
  "sessionIdleMs",
  "host",
  "port",
];

adminRouter.patch("/config", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<AppConfig> = {};
  for (const field of PATCHABLE) {
    if (field in body) (patch as Record<string, unknown>)[field] = body[field];
  }
  if (patch.modelOverrides && typeof patch.modelOverrides !== "object") {
    res.status(400).json({ ok: false, error: "modelOverrides 必须是对象" });
    return;
  }
  const config = updateConfig(patch);
  const needsRestart = "host" in patch || "port" in patch;
  res.json({ ok: true, config, needsRestart });
});

adminRouter.get("/requests", (_req: Request, res: Response) => {
  res.json({ ok: true, requests: recentRequests() });
});

/** 从管理面板发起一次真实调用，验证整条链路。 */
adminRouter.post("/test", async (req: Request, res: Response) => {
  const model = String((req.body as Record<string, unknown>)?.model ?? "").trim() || getConfig().defaultModel;
  let text = "";
  let finished = false;
  const sink: Sink = {
    start() {},
    textDelta(t: string) {
      text += t;
    },
    toolCalls(_calls: BridgeToolCall[]) {},
    finish(_reason: StopReason, usage: BridgeUsage) {
      finished = true;
      res.json({ ok: true, model, text: text.trim(), usage });
    },
    error(err: BridgeError) {
      finished = true;
      res.json({ ok: false, model, error: err.message });
    },
    isClosed() {
      return finished || res.writableEnded;
    },
  };
  await executeBridgeRequest(
    {
      requestedModel: model,
      system: "",
      messages: [
        {
          role: "user",
          text: "请只回复两个字：正常",
          images: [],
          toolCalls: [],
          toolResults: [],
        },
      ],
      tools: [],
      stopSequences: [],
      maxTokens: 100,
    },
    sink,
    { api: "test", keyLabel: "admin", stream: false },
  );
});
