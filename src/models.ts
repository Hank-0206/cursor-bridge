import { Cursor, type ModelParameterValue, type SDKModel } from "@cursor/sdk";
import { allowedModelSet, effectiveCursorKey, getConfig } from "./config.js";
import { info } from "./log.js";
import { BridgeError } from "./types.js";

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

export interface ResolvedModel {
  id: string;
  params?: ModelParameterValue[];
  /** 面板日志用的展示名：id 后附参数简写。 */
  label: string;
  via: string;
}

function buildLabel(id: string, params?: ModelParameterValue[]): string {
  if (!params || params.length === 0) return id;
  return `${id}[${params.map((p) => `${p.id}=${p.value}`).join(",")}]`;
}

/** "300k" / "1m" 之类上下文取值换算成可比较的数值（单位 k）。 */
function contextScore(value: string): number {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  if (!m) return 0;
  return parseFloat(m[1]!) * (m[2]!.toLowerCase() === "m" ? 1000 : 1);
}

/**
 * 解析计费标签风格的变体名，如：
 *   claude-opus-5-thinking-max-fast / gpt-5.6-luna-max /
 *   cursor-grok-4.5-high / gpt-5.5-extra-high / claude-opus-5-1m-xhigh
 * 返回 基础模型 + 显式参数；无法完整解析则返回 null。
 */
export function parseVariantName(
  nameLower: string,
  items: SDKModel[],
): { model: SDKModel; params: ModelParameterValue[] } | null {
  const candidates = nameLower.startsWith("cursor-") ? [nameLower.slice(7), nameLower] : [nameLower];
  for (const name of candidates) {
    // 取最长的 id/别名前缀（避免 gpt-5.6 抢走 gpt-5.6-luna 的匹配）
    let best: { model: SDKModel; rest: string; baseLen: number } | null = null;
    for (const m of items) {
      const bases = [m.id.toLowerCase(), ...(m.aliases ?? []).map((a) => a.toLowerCase())];
      for (const base of bases) {
        if (name.startsWith(base + "-") && (!best || base.length > best.baseLen)) {
          best = { model: m, rest: name.slice(base.length + 1), baseLen: base.length };
        }
      }
    }
    if (!best) continue;
    const params = parseVariantTokens(best.rest, best.model);
    if (params) return { model: best.model, params };
  }
  return null;
}

/** 把 "thinking-max-fast" 这类后缀逐词匹配到模型的参数定义上。 */
function parseVariantTokens(rest: string, model: SDKModel): ModelParameterValue[] | null {
  const defs = model.parameters ?? [];
  if (defs.length === 0) return null;
  const has = (pid: string) => defs.some((d) => d.id === pid);
  const chosen = new Map<string, string>();
  let tokens = rest.split("-").filter(Boolean);

  outer: while (tokens.length > 0) {
    // 取值本身可能含连字符（extra-high），从长到短尝试合并
    for (let k = Math.min(3, tokens.length); k >= 1; k--) {
      const word = tokens.slice(0, k).join("-");
      if (word === "thinking" && has("thinking") && !chosen.has("thinking")) {
        chosen.set("thinking", "true");
        tokens = tokens.slice(k);
        continue outer;
      }
      if (word === "fast" && has("fast") && !chosen.has("fast")) {
        chosen.set("fast", "true");
        tokens = tokens.slice(k);
        continue outer;
      }
      let hit = false;
      for (const d of defs) {
        if (chosen.has(d.id)) continue;
        const v = d.values.find((x) => x.value.toLowerCase() === word);
        if (v) {
          chosen.set(d.id, v.value);
          hit = true;
          break;
        }
      }
      if (hit) {
        tokens = tokens.slice(k);
        continue outer;
      }
    }
    return null; // 存在无法识别的片段，不视为变体名
  }

  if (chosen.size === 0) return null;
  return [...chosen].map(([id, value]) => ({ id, value }));
}

/**
 * 从模型的预设变体里挑“性能拉满”的一档：
 * thinking 开 > effort/reasoning 最高 > 上下文最大 > fast 开。
 * 只会返回官方枚举过的合法组合。
 */
export function pickMaxVariant(model: SDKModel): ModelParameterValue[] | undefined {
  const defs = model.parameters ?? [];
  const rankIn = (val: string): number => {
    for (const pid of ["effort", "reasoning"]) {
      const d = defs.find((x) => x.id === pid);
      if (d) {
        const i = d.values.findIndex((v) => v.value === val);
        if (i >= 0) return i;
      }
    }
    return 0;
  };

  const variants = model.variants ?? [];
  let best: { score: number; params: ModelParameterValue[] } | null = null;
  for (const v of variants) {
    const get = (pid: string) => v.params.find((p) => p.id === pid)?.value;
    let score = 0;
    if (get("thinking") === "true") score += 1e12;
    const effort = get("effort") ?? get("reasoning");
    if (effort !== undefined) score += (rankIn(effort) + 1) * 1e9;
    const ctx = get("context");
    if (ctx) score += contextScore(ctx) * 1e3;
    if (get("fast") === "true") score += 1;
    if (!best || score > best.score) best = { score, params: [...v.params] };
  }
  if (best && best.params.length > 0) return best.params;

  // 没有预设变体时按参数定义逐项取最高（定义序从低到高）
  if (defs.length === 0) return undefined;
  const params: ModelParameterValue[] = [];
  for (const d of defs) {
    if (d.values.length === 0) continue;
    if (d.id === "thinking" || d.id === "fast") {
      if (d.values.some((v) => v.value === "true")) params.push({ id: d.id, value: "true" });
    } else if (d.id === "context") {
      const top = [...d.values].sort((a, b) => contextScore(b.value) - contextScore(a.value))[0]!;
      params.push({ id: d.id, value: top.value });
    } else {
      params.push({ id: d.id, value: d.values[d.values.length - 1]!.value });
    }
  }
  return params.length > 0 ? params : undefined;
}

/**
 * 把客户端请求的模型名解析为 Cursor 模型 + 参数。
 * 顺序：手动映射 > 精确 id/别名 > 变体后缀名 > 去日期后缀 > 关键词启发式 > 默认模型。
 * 开启"性能拉满"后，凡未显式指定参数的请求一律套用该模型的最高有效组合。
 */
export async function resolveModel(requested: string): Promise<ResolvedModel> {
  const config = getConfig();
  const wantLower = requested.trim().toLowerCase();
  const overrideTarget = config.modelOverrides[wantLower];
  const effective = (overrideTarget ?? requested).trim();
  const effLower = effective.toLowerCase();
  const viaPrefix = overrideTarget ? "override→" : "";

  let items: SDKModel[] = [];
  try {
    items = await listModels();
  } catch {
    // 模型列表拿不到（还没配 key 等）时直接透传，让后端报有意义的错误。
    return { id: effective, label: effective, via: viaPrefix + "passthrough" };
  }

  const byExact = new Map<string, SDKModel>();
  for (const m of items) {
    byExact.set(m.id.toLowerCase(), m);
    for (const a of m.aliases ?? []) if (!byExact.has(a.toLowerCase())) byExact.set(a.toLowerCase(), m);
  }

  let model: SDKModel | undefined;
  let params: ModelParameterValue[] | undefined;
  let how = "";

  const exact = byExact.get(effLower);
  if (exact) {
    model = exact;
    how = "exact";
  }
  if (!model) {
    const variant = parseVariantName(effLower, items);
    if (variant) {
      model = variant.model;
      params = variant.params;
      how = "variant";
    }
  }
  if (!model) {
    const norm = byExact.get(normalize(effective));
    if (norm) {
      model = norm;
      how = "normalized";
    }
  }
  if (!model) {
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
    for (const [test, patterns] of heuristics) {
      if (!test.test(effLower)) continue;
      for (const p of patterns) {
        const hit = items.find((m) => p.test(m.id.toLowerCase()));
        if (hit) {
          model = hit;
          how = "heuristic";
          break;
        }
      }
      if (model) break;
    }
  }
  if (!model) {
    const fb = (config.defaultModel || "auto").trim();
    const fbModel = byExact.get(fb.toLowerCase());
    if (fbModel) {
      model = fbModel;
      how = "default";
    } else {
      const fbVariant = parseVariantName(fb.toLowerCase(), items);
      if (fbVariant) {
        model = fbVariant.model;
        params = fbVariant.params;
        how = "default-variant";
      } else {
        return { id: fb, label: fb, via: viaPrefix + "default-passthrough" };
      }
    }
  }

  if (!params && config.maximizeModels) {
    const maxParams = pickMaxVariant(model);
    if (maxParams) {
      params = maxParams;
      how += "+max";
    }
  }

  return { id: model.id, params, label: buildLabel(model.id, params), via: viaPrefix + how };
}

export function filterModelsForKey<T extends { id: string; aliases?: string[] }>(
  items: T[],
  allowedModels?: string[],
): T[] {
  const allowed = allowedModelSet(allowedModels);
  if (!allowed) return items;
  return items.filter(
    (m) =>
      allowed.has(m.id.toLowerCase()) || (m.aliases ?? []).some((a) => allowed.has(a.toLowerCase())),
  );
}

function modelAllowed(resolvedId: string, requested: string, allowed: Set<string>): boolean {
  if (allowed.has(resolvedId.toLowerCase())) return true;
  const req = requested.trim().toLowerCase();
  return Boolean(req) && allowed.has(req);
}

/**
 * 解析模型并套用令牌白名单。
 * 请求 `auto` 且默认模型不在白名单时，回落到白名单里的第一个模型。
 */
export async function resolveModelForKey(
  requested: string,
  allowedModels?: string[],
): Promise<ResolvedModel> {
  const allowed = allowedModelSet(allowedModels);
  let resolved = await resolveModel(requested);
  if (!allowed) return resolved;

  if (!modelAllowed(resolved.id, requested, allowed) && requested.trim().toLowerCase() === "auto") {
    const first = [...allowed][0];
    if (first) resolved = await resolveModel(first);
  }
  if (!modelAllowed(resolved.id, requested, allowed)) {
    throw new BridgeError(
      "forbidden",
      `该令牌无权使用模型 ${requested}（解析为 ${resolved.id}）。允许：${[...allowed].join(", ")}`,
    );
  }
  return resolved;
}
