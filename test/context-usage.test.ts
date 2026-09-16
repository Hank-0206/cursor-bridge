import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompactedResponse,
  decodeBridgeCompaction,
  encodeBridgeCompaction,
  isGrokBuildCompactionRequest,
  parseResponsesRequest,
  prepareGrokBuildCompaction,
  responsesUsageJson,
} from "../src/responses.js";
import { toBridgeError } from "../src/engine.js";
import { renderPrompt } from "../src/prompt.js";
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

const GROK_COMPACTION_PROMPT = `Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly after the earlier turns are discarded. The successor will see the user's original query plus this summary.

Respond with ONLY the <summary>...</summary> block. This is a system-generated compaction prompt.`;

test("Grok Build 的普通 Responses 压缩请求会进入专用模式", () => {
  const req = parseResponsesRequest({
    model: "grok-4.6",
    input: [
      { type: "message", role: "user", content: "修复上下文压缩" },
      { type: "message", role: "assistant", content: "正在检查请求路径。" },
      { type: "message", role: "user", content: GROK_COMPACTION_PROMPT },
    ],
    tools: [{ type: "function", name: "run_terminal_command", parameters: { type: "object" } }],
    max_output_tokens: 2_000,
  });

  assert.equal(isGrokBuildCompactionRequest(req), true);
  assert.equal(prepareGrokBuildCompaction(req), true);
  assert.equal(req.operation, "grok_compact");
  assert.equal(req.maxTokens, 16_384);
  assert.deepEqual(req.tools, []);

  const rendered = renderPrompt(req).text;
  assert.match(rendered, /You are a CONTEXT COMPACTOR/);
  assert.match(rendered, /exactly one <summary>\.\.\.<\/summary> block/);
  assert.doesNotMatch(rendered, /Now write the assistant's next reply/);
  assert.doesNotMatch(rendered, /system-generated compaction prompt/);
  assert.match(rendered, /修复上下文压缩/);
});

test("普通总结请求不会误判为 Grok Build 自动压缩", () => {
  const req = requestWithHistory("请总结一下当前进展，并说明下一步。 ");

  assert.equal(isGrokBuildCompactionRequest(req), false);
  assert.equal(prepareGrokBuildCompaction(req), false);
  assert.equal(req.operation, undefined);
});

test("Codex Multi-Agent v2 会把 agent_message 的明文任务展开给子代理", () => {
  const req = parseResponsesRequest({
    model: "grok-4.6",
    instructions: "You are Codex.",
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n",
          },
          { type: "encrypted_content", encrypted_content: "Reply with DELIVERY_OK only" },
        ],
      },
    ],
    tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "wait_agent", parameters: { type: "object" } },
    ],
  });

  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0]?.role, "user");
  assert.match(req.messages[0]?.text ?? "", /NEW_TASK/);
  assert.match(req.messages[0]?.text ?? "", /DELIVERY_OK/);
  assert.deepEqual(
    req.tools.map((tool) => tool.name),
    ["spawn_agent", "wait_agent", "Task", "task", "spawn_subagent"],
  );

  const rendered = renderPrompt(req).text;
  assert.match(rendered, /DELIVERY_OK/);
  assert.match(rendered, /spawn_agent/);
  assert.match(rendered, /Subagent tools in that list are real MCP tools/);
  assert.doesNotMatch(rendered, /No tools are available/);
});

test("Codex 明文 agent_message 和普通 message 里的 encrypted_content 也会保留", () => {
  const req = parseResponsesRequest({
    model: "auto",
    input: [
      {
        type: "agent_message",
        author: "/root/worker",
        recipient: "/root",
        content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\nAll tests passed." }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "Inspect src/engine.ts" },
        ],
      },
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/explorer",
        content: [{ type: "encrypted_content", encrypted_content: "Scan the auth module" }],
      },
    ],
    tools: [{ name: "collaboration__spawn_agent", parameters: { type: "object" } }],
  });

  assert.match(req.messages[0]?.text ?? "", /All tests passed/);
  assert.match(req.messages[1]?.text ?? "", /Inspect src\/engine\.ts/);
  assert.match(req.messages[2]?.text ?? "", /Scan the auth module/);
  assert.match(req.messages[2]?.text ?? "", /Sender: \/root/);
  assert.deepEqual(
    req.tools.map((tool) => tool.name),
    ["collaboration__spawn_agent", "Task", "task", "spawn_subagent"],
  );
});

test("Codex namespace 里的 spawn_agent 会展平并带上 namespace", () => {
  const req = parseResponsesRequest({
    model: "grok-4.6",
    input: [{ type: "message", role: "user", content: "派两个子代理" }],
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      {
        type: "namespace",
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            description: "Create a subagent and assign its initial task.",
            parameters: {
              type: "object",
              properties: {
                task_name: { type: "string" },
                message: { type: "string" },
              },
              required: ["task_name", "message"],
            },
          },
          {
            type: "function",
            name: "wait_agent",
            parameters: { type: "object" },
          },
        ],
      },
    ],
  });

  const spawn = req.tools.find((tool) => tool.name === "spawn_agent");
  const wait = req.tools.find((tool) => tool.name === "wait_agent");
  const alias = req.tools.find((tool) => tool.name === "Task");
  assert.equal(spawn?.namespace, "collaboration");
  assert.equal(wait?.namespace, "collaboration");
  assert.equal(alias?.emitAs, "spawn_agent");
  assert.ok(req.tools.some((tool) => tool.name === "exec_command"));
});

test("Cursor SDK 的 Authentication error 会归类为鉴权错误", () => {
  const err = toBridgeError(new Error("Authentication error If you are logged in, try logging out and back in."));

  assert.equal(err.kind, "auth");
  assert.match(err.message, /Cursor 鉴权失败/);
  assert.match(err.message, /请在管理面板检查 Cursor API Key/);
});
