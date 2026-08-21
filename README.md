# cursor-bridge

把你 Cursor 订阅里的模型反向代理成 **Anthropic Messages API**、**OpenAI Chat Completions API** 和 **OpenAI Responses API**，让 cc-switch / Claude Code / Codex / 各类 OpenAI 兼容客户端，以及**局域网里的其他人**都能用你的 Cursor 账号调用模型。

仓库：https://github.com/Hank-0206/cursor-bridge

```
局域网用户 (Claude Code / Codex / Cherry Studio / openai SDK ...)
        │  访问令牌 sk-cb-...
        ▼
┌─────────────────────────────────┐
│  cursor-bridge (你的电脑)         │
│  /v1/messages            ← Anthropic
│  /v1/chat/completions    ← OpenAI Chat
│  /v1/responses           ← OpenAI Responses（Codex）
│  /v1/models                     │
│  管理面板（仅本机可访问）            │
└──────────────┬──────────────────┘
               │  Cursor API Key (crsr_...)
               ▼
     Cursor 官方后端（@cursor/sdk 本地 agent，已禁用内置工具）
```

## 环境要求

- Node.js **>= 20**
- 一台已登录 / 已有 [Cursor API Key](https://cursor.com/dashboard/api) 的电脑（作为服务器）
- Windows / macOS / Linux 均可；本仓库的后台常驻脚本按 Windows 写

## 快速开始

```powershell
git clone https://github.com/Hank-0206/cursor-bridge.git
cd cursor-bridge
npm install
npm start          # 开发热重载用 npm run dev
```

启动后打开面板 **http://127.0.0.1:8318/**：

1. 在「Cursor API Key」卡片粘贴你的 Key（[cursor.com/dashboard → API Keys](https://cursor.com/dashboard/api) 生成），或点「浏览器登录」直接用 Cursor 账号授权；
2. 点「发送测试请求」确认链路通畅；
3. 在「访问令牌」卡片给每个使用者生成一个 `sk-cb-...` 令牌发给他们；
4. 使用者按面板「接入指南」里的模板配置即可。

默认监听 `0.0.0.0:8318`。临时换端口：

```powershell
$env:PORT='8319'; npm start
```

## 对外 API

所有 `/v1/*` 都要带访问令牌：`x-api-key: sk-cb-...` 或 `Authorization: Bearer sk-cb-...`。

| 方法 | 路径 | 协议 | 典型客户端 |
| --- | --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages | Claude Code、cc-switch |
| `POST` | `/v1/messages/count_tokens` | Anthropic | 估算 token |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions | Cherry Studio、openai SDK |
| `POST` | `/v1/responses` | OpenAI Responses | Codex CLI / Codex Desktop |
| `POST` | `/v1/responses/compact` | OpenAI Responses Compaction | Codex 长对话压缩 |
| `GET` | `/v1/models` | OpenAI | 列出可映射模型 |
| `GET` | `/healthz` | — | 健康检查（无需令牌） |

`/admin/*` 与配置修改只接受本机 `127.0.0.1`，局域网用户打不开管理接口。

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

## 直接配置 Claude Code

不经过 cc-switch 时，把同样的环境变量写进 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318",
    "ANTHROPIC_AUTH_TOKEN": "sk-cb-你的访问令牌"
  }
}
```

改完后重启 Claude Code。

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

Cherry Studio、NextChat 等填同样的 Base URL 和 API Key 即可。

## Codex（OpenAI Responses API）

Codex CLI / Codex Desktop 走 `/v1/responses`，不是 Chat Completions。在 `~/.codex/config.toml` 加一个自定义供应商：

```toml
model = "auto"
model_provider = "cursor_bridge"

[model_providers.cursor_bridge]
name = "cursor-bridge"
base_url = "http://127.0.0.1:8318/v1"
wire_api = "responses"
env_key = "CURSOR_BRIDGE_API_KEY"
```

然后设置令牌（PowerShell）：

```powershell
$env:CURSOR_BRIDGE_API_KEY = "sk-cb-你的访问令牌"
```

局域网另一台机器把 `base_url` 改成 `http://<服务器IP>:8318/v1`。模型名同样可用 `auto` 或 Cursor 模型 id（如 `composer-2.5`、`gpt-5.6-sol`）。

也可用 curl 直接打 Responses 接口：

```powershell
curl.exe -sN -X POST http://127.0.0.1:8318/v1/responses -H "content-type: application/json" -H "x-api-key: <令牌>" --data "@test/resp-stream.json"
```

代理同时实现 Codex 长对话使用的 `/v1/responses/compact`。压缩摘要会使用当前访问令牌
加密为不透明 `compaction` item；后续请求回传该 item 时由代理解密并作为精简后的会话状态继续使用。

## 局域网访问与防火墙

- 默认监听 `0.0.0.0:8318`，同一局域网内的设备用 `http://<你的IP>:8318` 访问（启动横幅和面板里都会显示检测到的 IP）。
- Windows 第一次启动时若弹出防火墙询问，勾选「专用网络」并允许；没弹窗而局域网连不上时，用管理员 PowerShell 手动放行：

```powershell
netsh advfirewall firewall add rule name="cursor-bridge" dir=in action=allow protocol=TCP localport=8318
```

- 只想本机使用：把 `data/config.json` 里的 `host` 改成 `127.0.0.1` 后重启。

## 安全模型

| 措施 | 说明 |
| --- | --- |
| 访问令牌 | 所有 `/v1/*` 请求必须携带 `sk-cb-...` 令牌（`x-api-key` 或 `Authorization: Bearer`），恒定时间比较，一人一个、可随时删除吊销 |
| 管理接口仅本机 | `/admin/*` 与配置修改只接受来自 `127.0.0.1` 的连接，局域网用户看不到你的 Cursor Key，也改不了配置 |
| Agent 工具封锁 | 通过 SDK 的 `tools: []` / `tools: ["mcp"]` 禁用 Cursor agent 的内置工具，局域网用户**无法**借模型在你机器上执行终端命令或读写文件 |
| Key 不落日志 | 日志与请求记录只保留令牌备注名，不记录任何密钥内容 |

费用提醒：所有调用消耗的都是你 Cursor 账号的额度，面板「用量统计 / 最近请求」可以看到每个令牌的使用情况；Key 泄露可随时到 Cursor Dashboard 撤销。

访问令牌可以单独限制模型：在面板「访问令牌」里点「可用模型」，勾选允许的 Cursor 模型 id。未勾选任何项（不限制）时行为与以前相同。受限令牌请求其它模型会返回 403，`GET /v1/models` 也只列出白名单。

## 工具调用桥接原理

Claude Code / Codex 这类客户端要求模型返回工具调用、由客户端本地执行后再回传结果。cursor-bridge 不用提示词模拟，而是把客户端声明的工具注册为 Cursor SDK 的 **customTools**（进程内 MCP 工具）：

1. 模型真实发起工具调用 → 代理拦截，转换成 `tool_use` / `function_call` 返回给客户端并结束本次 HTTP 响应，agent 运行保持挂起；
2. 客户端执行工具后带着 `tool_result` / `function_call_output` 再次请求 → 代理按调用 id 匹配回挂起的会话，注入结果，**同一个 agent 运行继续**，不重放上下文；
3. 匹配不上（服务重启、新对话轮次等）时自动降级为全量历史重放，正确性不受影响。

会话等待工具结果最长保活 10 分钟（`sessionIdleMs` 可调），超时自动取消并释放资源。

## 模型映射与思考强度

请求里的模型名按以下顺序解析成 Cursor 模型（含参数）：

1. 面板「手动模型映射」里的精确规则（如 `{"claude-haiku-4-5": "composer-2.5-fast"}`）；
2. 与 Cursor 模型 id / 别名精确匹配（可直接请求 `composer-2.5`、`gpt-5.2` 等）；
3. **变体后缀名**：`claude-opus-5-thinking-max-fast`、`gpt-5.6-luna-max`、`gpt-5.5-extra-high` 这类计费标签风格的名字会解析成 基础模型 + 思考/上下文/速度参数，客户端想用哪档直接在模型名里写；
4. 去掉 `-20250929`、`-latest` 之类后缀再匹配；
5. 关键词启发式：`opus` / `sonnet` / `haiku` / `gpt` / `gemini` / `grok` ...；
6. 兜底默认模型（默认 `auto`，面板可改）。

面板「性能拉满」开关（`maximizeModels`）开启后，凡是**没有显式指定档位**的请求，自动套用该模型官方预设里的最高组合：thinking 开 → effort/reasoning 最高 → 上下文最大 → 能开 fast 就开 fast（只挑官方枚举过的合法组合，例如 GPT 系 1m 上下文与 fast 不能共存时优先保上下文）。显式写了档位的模型名不受影响。注意：拉满会明显加快额度消耗。

## 用量统计

面板「用量统计」按访问令牌累计请求数、输入 / 输出 / 缓存读写 token，数据写在 `data/usage.json`，**重启不丢失**。可按令牌展开看各模型消耗，也可一键清零重计。

对外 API 响应里的 `usage` 表示当前请求实际携带的实时上下文，而不是 Cursor SDK
在连续工具调用期间产生的累计计费用量。Grok Build 等依赖 `total_tokens` 触发自动压缩的
客户端因此能在压缩完成后看到窗口占用确实下降，不会每一轮重复压缩。实时上下文用量
按约 4 字符 = 1 token 估算。

## 配置文件

`data/config.json`（已 gitignore，含密钥请勿外传）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `0.0.0.0` / `8318` | 监听地址与端口，改后需重启 |
| `cursorApiKey` | `""` | 也可用环境变量 `CURSOR_API_KEY` 或 SDK 浏览器登录代替 |
| `proxyKeys` | 自动生成 1 个 | 访问令牌列表。每项可带 `allowedModels`（Cursor 模型 id 数组）；缺省或 `[]` 表示不限制 |
| `defaultModel` | `auto` | 模型解析兜底 |
| `modelOverrides` | `{}` | 手动模型映射 |
| `allowClientTools` | `true` | 关掉则忽略客户端工具（纯对话） |
| `maximizeModels` | `false` | 未写档位时自动拉满思考 / 上下文 / 速度 |
| `maxConcurrentRuns` | `4` | 并发上限，超出排队 |
| `requestTimeoutMs` / `sessionIdleMs` | 600000 | 输出超时 / 工具等待保活 |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `CURSOR_API_KEY` | Cursor 官方 Key，面板未填时回退到它 |
| `PORT` | 覆盖 `config.json` 里的监听端口 |
| `CB_MOCK` | `1` = 不调真实模型；`tool` = 再模拟一次工具调用 |

## 已知限制

- `temperature` / `top_p` 等采样参数不透传（Cursor SDK 不暴露）；`thinking` 思维链内容不回传给客户端。
- Anthropic 的服务端内置工具（`web_search` 等带 `type` 的工具）会被忽略，只桥接自定义工具。
- 每个新对话轮次会创建一次 agent（首 token 延迟约几秒）；同一轮内的连续工具调用走会话续接，无额外开销。
- token 用量在后端未上报时为估算值（约 4 字符 = 1 token）。

## 作为后台服务常驻运行（Windows）

`scripts/` 下的脚本已做成路径自适应，解压到任意目录都能用：

- **启动（隐藏窗口、崩溃自动重启）**：双击 `scripts\start-hidden.vbs`
- **停止**：运行 `scripts\stop-server.cmd`
- **运行日志**：`data\server.log`
- **开机自启**：按 `Win+R` 输入 `shell:startup` 打开启动文件夹，把 `scripts\start-hidden.vbs` 的快捷方式放进去；或在注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 加一项，值为 `wscript.exe "<项目路径>\scripts\start-hidden.vbs"`。
  - 注意：部分安全软件会拦截脚本类自启，若开机后服务没起来，手动双击 `start-hidden.vbs` 或在安全软件里加信任。

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
curl.exe -sN -X POST http://127.0.0.1:8318/v1/responses -H "content-type: application/json" -H "x-api-key: <令牌>" --data "@test/resp-stream.json"
```
