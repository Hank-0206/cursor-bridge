import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

export const SESSION_COOKIE = "cb_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SEC * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

type Session = { expiresAt: number };
type Attempt = { count: number; resetAt: number };

const sessions = new Map<string, Session>();
const attempts = new Map<string, Attempt>();

function pruneMap<T extends { expiresAt?: number; resetAt?: number }>(map: Map<string, T>, now: number): void {
  for (const [key, value] of map) {
    const exp = value.expiresAt ?? value.resetAt ?? 0;
    if (exp <= now) map.delete(key);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionFromRequest(req: Request): string {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "";
}

export function createSession(): string {
  pruneMap(sessions, Date.now());
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroySession(token: string): void {
  if (token) sessions.delete(token);
}

export function hasValidSession(req: Request): boolean {
  const token = sessionFromRequest(req);
  if (!token) return false;
  const row = sessions.get(token);
  if (!row) return false;
  if (row.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function wantsSecureCookie(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",")[0]?.trim().toLowerCase() === "https";
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.setHeader("Set-Cookie", sessionCookieHeader(token, wantsSecureCookie(req)));
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader("Set-Cookie", clearSessionCookieHeader(wantsSecureCookie(req)));
}

export function consumeLoginAttempt(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  pruneMap(attempts, now);
  const key = ip || "unknown";
  const row = attempts.get(key);
  if (!row || row.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { ok: true };
  }
  if (row.count >= LOGIN_MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((row.resetAt - now) / 1000)) };
  }
  row.count += 1;
  return { ok: true };
}

export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip || "unknown");
}
