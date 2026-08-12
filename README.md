# cursor-bridge

把你 Cursor 订阅里的模型反向代理成 **Anthropic Messages API** 和 **OpenAI Chat Completions API**，让 cc-switch / Claude Code / 各类 OpenAI 兼容客户端，以及**局域网里的其他人**都能用你的 Cursor 账号调用模型。

```
局域网用户 (Claude Code / Cherry Studio / openai SDK ...)
        │  访问令牌 sk-cb-...
        ▼
┌─────────────────────────────┐
│  cursor-bridge (你的电脑)     │
│  /v1/messages          ← Anthropic 协议
│  /v1/chat/completions  ← OpenAI 协议
│  /v1/models                  │
│  管理面板（仅本机可访问）        │
└──────────┬──────────────────┘
           │  Cursor API Key (crsr_...)
           ▼
     Cursor 官方后端（@cursor/sdk 本地 agent，已禁用内置工具）
```

## 快速开始

```powershell
npm install
npm run dev        # 或 npm start
```

启动后打开面板 **http://127.0.0.1:8318/**：

1. 在「Cursor API Key」卡片粘贴你的 Key（[cursor.com/dashboard → API Keys](https://cursor.com/dashboard/api) 生成），或点「浏览器登录」直接用 Cursor 账号授权；
2. 点「发送测试请求」确认链路通畅；
3. 在「访问令牌」卡片给每个使用者生成一个 `sk-cb-...` 令牌发给他们；
4. 使用者按面板「接入指南」里的模板配置即可。

## 在 cc-switch 里配置

CC Switch → 添加供应商 → 应用选 **Claude Code** → 预设选 **自定义**，JSON 填：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<服务器局域网IP>:8318",
    "ANTHROPIC_AUTH_TOKEN": "sk-cb-你的访问令牌"
  }
}
```

切换到该供应商后重启 Claude Code 即生效。服务器本机自用可以填 `http://127.0.0.1:8318`。

> 如果之前在 `~/.zshrc` / PowerShell Profile 里手动 export 过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，环境变量优先级更高，记得清掉，否则 cc-switch 的切换不生效。

## OpenAI 兼容客户端

- Base URL：`http://<服务器IP>:8318/v1`
- API Key：访问令牌 `sk-cb-...`
- 模型名：`auto`（由 Cursor 自动选）或任意 Cursor 模型 id（`GET /v1/models` 可查，面板里也有列表）

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.x.x:8318/v1", api_key="sk-cb-...")
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "你好"}])
print(r.choices[0].message.content)
```

## 局域网访问与防火墙

- 默认监听 `0.0.0.0:8318`，同一局域网内的设备用 `http://<你的IP>:8318` 访问（启动横幅和面板里都会显示检测到的 IP）。
- Windows 第一次启动时若弹出防火墙询问，勾选「专用网络」并允许；没弹窗而局域网连不上时，用管理员 PowerShell 手动放行：

```powershell
netsh advfirewall firewall add rule name="cursor-bridge" dir=in action=allow protocol=TCP localport=8318
```

- 只想本机使用：面板改不了监听地址的话，把 `data/config.json` 里的 `host` 改成 `127.0.0.1` 后重启。

## 安全模型

| 措施 | 说明 |
| --- | --- |
| 访问令牌 | 所有 `/v1/*` 请求必须携带 `sk-cb-...` 令牌（`x-api-key` 或 `Authorization: Bearer`），恒定时间比较，一人一个、可随时删除吊销 |
| 管理接口仅本机 | `/admin/*` 与配置修改只接受来自 `127.0.0.1` 的连接，局域网用户看不到你的 Cursor Key，也改不了配置 |
| Agent 工具封锁 | 通过 SDK 的 `tools: []` / `tools: ["mcp"]` 禁用 Cursor agent 的内置工具，局域网用户**无法**借模型在你机器上执行终端命令或读写文件 |
| Key 不落日志 | 日志与请求记录只保留令牌备注名，不记录任何密钥内容 |

费用提醒：所有调用消耗的都是你 Cursor 账号的额度，面板「最近请求」可以看到每个令牌的使用情况；Key 泄露可随时到 Cursor Dashboard 撤销。

## 工具调用桥接原理

Claude Code 这类客户端要求模型返回 `tool_use`、由客户端本地执行工具后回传结果。cursor-bridge 不用提示词模拟，而是把客户端声明的工具注册为 Cursor SDK 的 **customTools**（进程内 MCP 工具）：

1. 模型真实发起工具调用 → 代理拦截，转换成 `tool_use` 返回给客户端并结束本次 HTTP 响应，agent 运行保持挂起；
2. 客户端执行工具后带着 `tool_result` 再次请求 → 代理按 `tool_use_id` 匹配回挂起的会话，注入结果，**同一个 agent 运行继续**，不重放上下文；
3. 匹配不上（服务重启、新对话轮次等）时自动降级为全量历史重放，正确性不受影响。

会话等待工具结果最长保活 10 分钟（`sessionIdleMs` 可调），超时自动取消并释放资源。

## 模型映射

请求里的模型名按以下顺序解析成 Cursor 模型 id：

1. 面板「手动模型映射」里的精确规则（如 `{"claude-haiku-4-5": "composer-2.5-fast"}`）；
2. 与 Cursor 模型 id / 别名精确匹配（可直接请求 `composer-2.5`、`gpt-5.2` 等）；
3. 去掉 `-20250929`、`-latest` 之类后缀再匹配；
4. 关键词启发式：`opus` / `sonnet` / `haiku` / `gpt` / `gemini` / `grok` ...；
5. 兜底默认模型（默认 `auto`，面板可改）。

## 配置文件

`data/config.json`（已 gitignore，含密钥请勿外传）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `0.0.0.0` / `8318` | 监听地址与端口，改后需重启 |
| `cursorApiKey` | `""` | 也可用环境变量 `CURSOR_API_KEY` 或 SDK 浏览器登录代替 |
| `proxyKeys` | 自动生成 1 个 | 访问令牌列表 |
| `defaultModel` | `auto` | 模型解析兜底 |
| `modelOverrides` | `{}` | 手动模型映射 |
| `allowClientTools` | `true` | 关掉则忽略客户端工具（纯对话） |
| `maxConcurrentRuns` | `4` | 并发上限，超出排队 |
| `requestTimeoutMs` / `sessionIdleMs` | 600000 | 输出超时 / 工具等待保活 |

## 已知限制

- `temperature` / `top_p` 等采样参数不透传（Cursor SDK 不暴露）；`thinking` 思维链内容不回传给客户端。
- Anthropic 的服务端内置工具（`web_search` 等带 `type` 的工具）会被忽略，只桥接自定义工具。
- 每个新对话轮次会创建一次 agent（首 token 延迟约几秒）；同一轮内的连续工具调用走会话续接，无额外开销。
- token 用量在后端未上报时为估算值（约 4 字符 = 1 token）。

## 开发

```powershell
npm run dev          # tsx watch 热重载
npm run typecheck    # TypeScript 类型检查
$env:CB_MOCK='1'; npm run dev    # mock 模式：不调真实模型，联调协议用
$env:CB_MOCK='tool'; npm run dev # mock 模式并模拟一次工具调用
```

`test/` 下有现成的请求载荷，可用 curl 直接打：

```powershell
curl.exe -sN -X POST http://127.0.0.1:8318/v1/messages -H "content-type: application/json" -H "x-api-key: <令牌>" --data "@test/msg-stream.json"
```
