// 用真实模型目录验证 变体名解析 / 拉满选择 / 完整解析链路（只读，不启服务）。
import { updateConfig } from "../src/config.js";
import { listModels, parseVariantName, pickMaxVariant, resolveModel } from "../src/models.js";

const items = await listModels();

console.log("=== 变体名解析 ===");
const names = [
  "claude-opus-5-thinking-max-fast",
  "cursor-grok-4.5-high",
  "gpt-5.6-luna-max",
  "gpt-5.5-extra-high",
  "claude-fable-5-thinking-max",
  "claude-sonnet-4-5-20250929",
  "composer-2.5-fast",
  "kimi-k3-max",
  "opus-thinking-max",
  "gpt-5.6-sol-1m-max",
];
for (const n of names) {
  const v = parseVariantName(n.toLowerCase(), items);
  console.log(
    `${n} => ${v ? `${v.model.id} {${v.params.map((p) => `${p.id}=${p.value}`).join(",")}}` : "(非变体名)"}`,
  );
}

console.log("\n=== 各模型拉满档 ===");
for (const m of items) {
  const p = pickMaxVariant(m);
  console.log(`${m.id} => ${p ? p.map((x) => `${x.id}=${x.value}`).join(",") : "(无参数)"}`);
}

console.log("\n=== resolveModel 完整链路（maximize=off）===");
for (const n of ["claude-opus-5-thinking-max", "claude-sonnet-4-5-20250929", "auto", "gpt-4o"]) {
  const r = await resolveModel(n);
  console.log(`${n} => ${r.label} (${r.via})`);
}

updateConfig({ maximizeModels: true });
console.log("\n=== resolveModel 完整链路（maximize=on）===");
for (const n of ["claude-sonnet-4-5-20250929", "claude-opus-5", "gpt-5.6-sol", "claude-opus-5-low", "haiku", "auto"]) {
  const r = await resolveModel(n);
  console.log(`${n} => ${r.label} (${r.via})`);
}
