// 独立验证：Agent 是否接受 ModelSelection.params（完整组合 / 部分参数）。
// 只创建独立进程内的 agent，不经过 cursor-bridge 服务。
const { readFileSync } = require("node:fs");
const path = require("node:path");

async function main() {
  const { Agent } = require("@cursor/sdk");
  const cfg = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "config.json"), "utf8"));
  const apiKey = (cfg.cursorApiKey || process.env.CURSOR_API_KEY || "").trim() || undefined;
  const sandbox = path.join(__dirname, "..", "data", "sandbox");

  async function probe(label, model) {
    const t0 = Date.now();
    try {
      const result = await Agent.prompt("Reply with exactly: OK", {
        ...(apiKey ? { apiKey } : {}),
        model,
        tools: [],
        local: { cwd: sandbox, settingSources: [] },
      });
      console.log(
        `${label}\n  status=${result.status} ${Math.round((Date.now() - t0) / 1000)}s ` +
          `reply=${JSON.stringify((result.result ?? "").slice(0, 40))}\n  echo model=${JSON.stringify(result.model)}`,
      );
    } catch (e) {
      console.log(`${label}\n  THROW: ${e.message}`);
    }
  }

  await probe("A. opus-5 完整 max 组合 (thinking/1m/max/fast)", {
    id: "claude-opus-5",
    params: [
      { id: "thinking", value: "true" },
      { id: "context", value: "1m" },
      { id: "effort", value: "max" },
      { id: "fast", value: "true" },
    ],
  });

  await probe("B. gpt-5.6-sol 部分参数 (仅 reasoning=max)", {
    id: "gpt-5.6-sol",
    params: [{ id: "reasoning", value: "max" }],
  });
}

main().catch((e) => {
  console.error("探测失败:", e);
  process.exit(1);
});
