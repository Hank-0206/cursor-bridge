// 从运行中的实例抓取内存里的最近请求记录，生成 data/usage.json 种子。
// 需在重启前、旧实例仍在运行时执行。
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const res = await fetch("http://127.0.0.1:8318/admin/requests");
  const { requests } = await res.json();
  const store = { since: new Date().toISOString(), keys: {} };
  let earliest = null;
  for (const q of requests) {
    if (q.api === "test") continue; // 管理面板的测试请求不计入
    if (!earliest || q.ts < earliest) earliest = q.ts;
    const label = q.keyLabel || "unknown";
    let k = store.keys[label];
    if (!k) {
      k = store.keys[label] = {
        label, requests: 0, ok: 0, toolUse: 0, errors: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        lastUsed: q.ts, models: {},
      };
    }
    k.requests += 1;
    if (q.status === "ok") k.ok += 1;
    else if (q.status === "tool_use") k.toolUse += 1;
    else k.errors += 1;
    k.inputTokens += q.inputTokens || 0;
    k.outputTokens += q.outputTokens || 0;
    if (q.ts > k.lastUsed) k.lastUsed = q.ts;
    const base = (q.cursorModel || "unknown").replace(/\[.*$/, "").trim() || "unknown";
    const m = k.models[base] || (k.models[base] = { requests: 0, inputTokens: 0, outputTokens: 0 });
    m.requests += 1;
    m.inputTokens += q.inputTokens || 0;
    m.outputTokens += q.outputTokens || 0;
  }
  if (earliest) store.since = earliest;
  fs.writeFileSync(path.join(__dirname, "..", "data", "usage.json"), JSON.stringify(store, null, 2), "utf8");
  console.log(`种子完成，覆盖 ${Object.keys(store.keys).length} 个令牌，自 ${store.since}`);
  for (const k of Object.values(store.keys)) {
    console.log(`  ${k.label}: 请求 ${k.requests}, in=${k.inputTokens}, out=${k.outputTokens}`);
  }
}

main().catch((e) => {
  console.error("种子失败:", e.message);
  process.exit(1);
});
