import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompactedResponse,
  decodeBridgeCompaction,
  encodeBridgeCompaction,
  parseResponsesRequest,
  responsesUsageJson,
} from "../src/responses.js";
import {
  buildLiveContextUsage,
  estimateRequestTokens,
  type BridgeRequest,
} from "../src/types.js";

/** 创建仅包含指定历史文本的测试请求。 */
function requestWithHistory(history: string): BridgeRequest {
  return {
    requestedModel: "auto",
    system: "你是编码助手。",
    messages: [
      { role: "user", text: history, images: [], toolCalls: [], toolResults: [] },
    ],
    tools: [],
    stopSequences: [],
  };
}

test("压缩后的实时上下文用量会明显下降", () => {
  const full = requestWithHistory("旧对话内容".repeat(20_000));
  const compacted = requestWithHistory("这是压缩后的会话摘要。".repeat(200));

  const fullUsage = buildLiveContextUsage(estimateRequestTokens(full), 400, 0);
  const compactedUsage = buildLiveContextUsage(estimateRequestTokens(compacted), 400, 0);

  assert.ok(compactedUsage.inputTokens < fullUsage.inputTokens / 20);
  assert.equal(compactedUsage.outputTokens, 100);
});

test("工具调用输出计入当前响应但不会累加旧轮次用量", () => {
  const usage = buildLiveContextUsage(1_000, 40, 25);

  assert.deepEqual(usage, {
    inputTokens: 1_000,
    outputTokens: 35,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: true,
  });
});

test("Responses API 返回 Grok Build 使用的实时上下文字段", () => {
  const json = responsesUsageJson(buildLiveContextUsage(1_200, 200, 0));

  assert.equal(json.total_tokens, 1_250);
  assert.deepEqual(json.context_details, { input_tokens: 1_200, output_tokens: 50 });
});

test("Codex 压缩摘要可使用同一访问令牌加密并解密", () => {
  const secret = "sk-cb-test-secret";
  const summary = "目标：修复上下文膨胀。\n进度：已完成实时用量修复。";
  const encrypted = encodeBridgeCompaction(summary, secret);

  assert.ok(encrypted.startsWith("cb1."));
  assert.notEqual(encrypted.includes(summary), true);
  assert.equal(decodeBridgeCompaction(encrypted, secret), summary);
  assert.throws(
    () => decodeBridgeCompaction(encrypted, "另一个访问令牌"),
    /压缩上下文已损坏或访问令牌已变更/,
  );
});

test("Codex compact 响应只保留用户消息和一个压缩项", () => {
  const secret = "sk-cb-test-secret";
  const usage = buildLiveContextUsage(12_000, 2_000, 0);
  const originalInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "修复问题" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "处理中" }] },
    { type: "function_call_output", call_id: "call_1", output: "大量旧工具输出".repeat(20_000) },
  ];
  const response = buildCompactedResponse(
    originalInput,
    "已定位并修复问题，下一步运行测试。",
    secret,
    usage,
  );
  const output = response.output as Array<Record<string, unknown>>;

  assert.equal(response.object, "response.compaction");
  assert.equal(output.length, 2);
  assert.equal(output[0]?.role, "user");
  assert.equal(output[1]?.type, "compaction");

  const resumed = parseResponsesRequest({
    model: "auto",
    input: [...output, { type: "message", role: "user", content: "继续处理" }],
  }, secret);
  const original = parseResponsesRequest({ model: "auto", input: originalInput }, secret);
  assert.match(resumed.messages[1]?.text ?? "", /已定位并修复问题/);
  assert.equal(resumed.messages[2]?.text, "继续处理");
  assert.ok(estimateRequestTokens(resumed) < estimateRequestTokens(original) / 100);
});
