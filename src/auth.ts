import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getConfig, type ProxyKey } from "./config.js";

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function extractToken(req: Request): string {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

export function verifyProxyKey(token: string): ProxyKey | null {
  if (!token) return null;
  for (const pk of getConfig().proxyKeys) {
    if (safeEqual(pk.key, token)) return pk;
  }
  return null;
}

/** /v1/* 接口的访问令牌校验。错误格式按协议区分。 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const pk = verifyProxyKey(token);
  if (pk) {
    (req as Request & { proxyKeyLabel?: string }).proxyKeyLabel = pk.label;
    next();
    return;
  }
  const message = token
    ? "访问令牌无效。请向代理管理员获取有效令牌。"
    : "缺少访问令牌。请在 x-api-key 或 Authorization: Bearer 头中携带令牌。";
  if ((req.baseUrl + req.path).startsWith("/v1/messages")) {
    res.status(401).json({ type: "error", error: { type: "authentication_error", message } });
  } else {
    res.status(401).json({ error: { message, type: "invalid_request_error", code: "invalid_api_key" } });
  }
}

export function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("::ffff:127.");
}

/** 管理接口只允许服务器本机访问，局域网用户无法读取/修改配置。 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (isLoopback(req)) {
    next();
    return;
  }
  res.status(403).json({ error: { message: "管理接口仅允许在服务器本机访问", type: "forbidden" } });
}
