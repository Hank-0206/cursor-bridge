// 只读探测：列出各模型支持的参数(思考强度等)与预设变体。不影响运行中的服务。
const { readFileSync } = require("node:fs");
const path = require("node:path");

async function main() {
  const { Cursor } = require("@cursor/sdk");
  const cfg = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "config.json"), "utf8"));
  const apiKey = (cfg.cursorApiKey || process.env.CURSOR_API_KEY || "").trim();
  const models = await Cursor.models.list(apiKey ? { apiKey } : undefined);
  for (const m of models) {
    const hasParams = (m.parameters && m.parameters.length) || (m.variants && m.variants.length);
    if (!hasParams) continue;
    console.log(`\n=== ${m.id} (${m.displayName}) ===`);
    for (const p of m.parameters ?? []) {
      console.log(`  参数 ${p.id}: ${p.values.map((v) => v.value).join(" | ")}`);
    }
    for (const v of m.variants ?? []) {
      console.log(
        `  变体 "${v.displayName}"${v.isDefault ? " [默认]" : ""}: ` +
          v.params.map((p) => `${p.id}=${p.value}`).join(", "),
      );
    }
  }
}

main().catch((e) => {
  console.error("探测失败:", e.message);
  process.exit(1);
});
