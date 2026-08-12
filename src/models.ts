import { Cursor, type SDKModel } from "@cursor/sdk";
import { effectiveCursorKey, getConfig } from "./config.js";
import { info } from "./log.js";

const CACHE_TTL_MS = 5 * 60_000;

let cache: { at: number; items: SDKModel[] } | null = null;
let inflight: Promise<SDKModel[]> | null = null;

export async function listModels(force = false): Promise<SDKModel[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;
  if (inflight) return inflight;
  inflight = (async () => {
    const { key } = effectiveCursorKey();
    const items = await Cursor.models.list(key ? { apiKey: key } : undefined);
    cache = { at: Date.now(), items };
    info(`已获取模型列表：${items.length} 个`);
    return items;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function cachedModels(): { items: SDKModel[]; fetchedAt: number } | null {
  return cache ? { items: cache.items, fetchedAt: cache.at } : null;
}

export function invalidateModelCache(): void {
  cache = null;
}

/** 去掉常见的日期/版本后缀，例如 claude-sonnet-4-5-20250929 -> claude-sonnet-4-5 */
function normalize(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-_.](20\d{6}|latest|v\d+(\.\d+)*)$/g, "")
    .trim();
}

interface Resolved {
  id: string;
  via: string;
}

/**
 * 把客户端请求的模型名解析为 Cursor 模型 id。
 * 顺序：手动映射 > 精确 id/别名 > 去后缀匹配 > 关键词启发式 > 默认模型。
 */
export async function resolveModel(requested: string): Promise<Resolved> {
  const config = getConfig();
  const want = requested.trim();
  const wantLower = want.toLowerCase();

  const override = config.modelOverrides[wantLower];
  if (override) return { id: override, via: "override" };

  let items: SDKModel[] = [];
  try {
    items = await listModels();
  } catch {
    // 模型列表拿不到（还没配 key 等）时直接透传，让后端报有意义的错误。
    return { id: want, via: "passthrough" };
  }

  const byExact = new Map<string, string>();
  for (const m of items) {
    byExact.set(m.id.toLowerCase(), m.id);
    for (const a of m.aliases ?? []) byExact.set(a.toLowerCase(), m.id);
  }
  const exact = byExact.get(wantLower);
  if (exact) return { id: exact, via: "exact" };

  const norm = byExact.get(normalize(want));
  if (norm) return { id: norm, via: "normalized" };

  const ids = items.map((m) => m.id);
  const firstMatching = (re: RegExp): string | undefined => ids.find((id) => re.test(id.toLowerCase()));

  const heuristics: Array<[RegExp, RegExp[]]> = [
    [/opus/, [/opus/]],
    [/sonnet/, [/sonnet/]],
    [/haiku/, [/fast|flash|mini|nano|lite/, /composer/]],
    [/claude/, [/claude/]],
    [/gpt|^o\d/, [/gpt/]],
    [/gemini/, [/gemini/]],
    [/grok/, [/grok/]],
    [/composer|cheetah/, [/composer/]],
    [/deepseek|kimi|qwen|glm/, [/composer/]],
  ];
  for (const [test, candidates] of heuristics) {
    if (!test.test(wantLower)) continue;
    for (const c of candidates) {
      const hit = firstMatching(c);
      if (hit) return { id: hit, via: "heuristic" };
    }
  }

  const fallback = config.defaultModel || "auto";
  return { id: byExact.get(fallback.toLowerCase()) ?? fallback, via: "default" };
}
