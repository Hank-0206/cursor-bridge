import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminRouter, lanAddresses } from "./admin.js";
import { handleAnthropicMessages, handleCountTokens } from "./anthropic.js";
import { requireApiKey, requireLoopback, type AuthedRequest } from "./auth.js";
import { effectiveCursorKey, getConfig, loadConfig, maskKey } from "./config.js";
import { info, warn } from "./log.js";
import { handleChatCompletions, handleListModels } from "./openai.js";
import { handleResponses } from "./responses.js";
import { flushUsage } from "./usage.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "80mb" }));

/** 允许浏览器端客户端（如网页版聊天 UI）跨域调用 API。 */
app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "cursor-bridge" });
});

/* ---------------- 对外 API（需访问令牌） ---------------- */

app.use("/v1", requireApiKey);

app.post("/v1/messages", (req, res) => {
  void handleAnthropicMessages(req, res, (req as AuthedRequest).proxyKeyLabel ?? "unknown").catch((err) => {
    warn(`处理 /v1/messages 时未捕获错误: ${err}`);
    if (!res.headersSent) res.status(500).json({ type: "error", error: { type: "api_error", message: String(err) } });
  });
});

app.post("/v1/messages/count_tokens", (req, res) => {
  handleCountTokens(req, res);
});

app.post("/v1/chat/completions", (req, res) => {
  void handleChatCompletions(req, res, (req as AuthedRequest).proxyKeyLabel ?? "unknown").catch((err) => {
    warn(`处理 /v1/chat/completions 时未捕获错误: ${err}`);
    if (!res.headersSent) res.status(500).json({ error: { message: String(err), type: "server_error" } });
  });
});

app.post("/v1/responses", (req, res) => {
  void handleResponses(req, res, (req as AuthedRequest).proxyKeyLabel ?? "unknown").catch((err) => {
    warn(`处理 /v1/responses 时未捕获错误: ${err}`);
    if (!res.headersSent) res.status(500).json({ error: { message: String(err), type: "server_error" } });
  });
});

app.get("/v1/models", (req, res) => {
  void handleListModels(req, res);
});

/* ---------------- 管理接口（仅本机） ---------------- */

app.use("/admin", requireLoopback, adminRouter);

/* ---------------- 面板页面 ---------------- */

app.use(express.static(path.join(rootDir, "public")));

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: { message: `未知路径 ${req.method} ${req.path}`, type: "not_found" } });
});

/* ---------------- 启动 ---------------- */

const listenPort = process.env.PORT ? Number(process.env.PORT) : config.port;
const server = app.listen(listenPort, config.host, () => {
  const { source } = effectiveCursorKey();
  const firstKey = config.proxyKeys[0];
  const lans = lanAddresses();
  console.log("");
  console.log("======================================================");
  console.log("  cursor-bridge 已启动");
  console.log(`  本机面板:    http://127.0.0.1:${config.port}/`);
  if (config.host === "0.0.0.0" && lans.length > 0) {
    for (const ip of lans) {
      console.log(`  局域网地址:  http://${ip}:${config.port}`);
    }
  } else if (config.host !== "0.0.0.0") {
    console.log(`  监听地址:    ${config.host}:${config.port}（未开放局域网）`);
  }
  console.log(`  Cursor Key:  ${source === "none" ? "未配置（请打开面板填写）" : `来源 ${source}`}`);
  if (firstKey) {
    console.log(`  访问令牌:    ${maskKey(firstKey.key)}（完整令牌见面板）`);
  }
  if (process.env.CB_MOCK) {
    console.log(`  ** MOCK 模式已开启（CB_MOCK=${process.env.CB_MOCK}），不会调用真实模型 **`);
  }
  console.log("======================================================");
  console.log("");
  info("等待请求中...");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${listenPort} 已被占用，请修改 data/config.json 中的 port 后重试`);
  } else {
    console.error(`服务启动失败: ${err.message}`);
  }
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    info("正在关闭...");
    flushUsage();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on("exit", () => flushUsage());
