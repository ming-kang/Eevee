# HTTP 接口

这一页列出 Engine 的全部 HTTP 接口。怎样找到 Engine、拿到 token 并发出第一个请求，见 [接入本地接口](integration.md)。接口的完整类型定义在 `src/api/contract.ts`。

## 约定

- 地址为 `http://127.0.0.1:<端口>`，端口见 `runtime/engine.json`。`Host` 和 `Origin`（如果有）必须是回环地址。
- 请求体和响应体都是 JSON，请求体最大 1 MB。
- token 放在 `x-eevee-token` 请求头里。下表“访问”一列：**公开**不需要 token；**CLI** 只接受 CLI token；**任意**接受 CLI token 或浏览器会话 token。
- 路径里的 `:project` 是项目编号（如 `p3f9a1c2e`），`:ticket` 是工单编号（如 `t3`），`:question` 是问题编号（如 `q2`），`:scope` 是 `project` 或 `global`，`:role` 是 `router`、`worker` 或 `dreamer`。
- 没有数据要返回的接口，响应为 `{ "ok": true }`，下表写作 `{ ok }`。

## 错误

失败时返回对应的状态码和：

```json
{ "error": { "code": "no_project", "message": "没有项目 p0000abcd" } }
```

| 状态 | `code` | 含义 |
|---|---|---|
| 400 | `bad_request` | 参数不合法，`message` 说明是哪个 |
| 400 | `bad_json` | 请求体不是合法的 JSON |
| 401 | `unauthorized` | 缺少 token 或 token 无效 |
| 401 | `bad_code` | 授权码无效或已过期 |
| 403 | `forbidden_host` | 请求不是发往回环地址，或 `Origin` 不是回环地址 |
| 403 | `cli_only` | 这个接口只接受 CLI token |
| 404 | `no_project` | 项目不存在 |
| 404 | `not_found` | 接口、工单或问题不存在 |
| 404 | `unknown_model` | 模型或 provider 不存在 |
| 404 | `unknown_extension` | 要启用的扩展没有安装 |
| 409 | `conflict` | 当前状态不允许这个操作，比如重试一轮没有失败的对话 |
| 409 | `memory_history` | 记忆历史操作失败，比如撤销与后来的改动冲突 |
| 413 | `too_large` | 请求体超过 1 MB |
| 500 | `internal` | 内部错误，详情写进 Engine 日志 |

## Engine

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `GET /api/health` | 公开 | — | `{ ok }` |
| `GET /api/status` | 任意 | — | `{ bootId, version, port, projects }` |
| `POST /api/shutdown` | CLI | — | `{ ok }`，随后 Engine 退出 |

`projects` 是项目摘要的数组：`{ id, title, workspace, createdAt, models? }`。

## 授权

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `POST /api/session/code` | CLI | — | `{ code }`：90 秒内有效的一次性授权码 |
| `POST /api/session` | 公开 | `{ code }` | `{ token }`：会话 token，12 小时无操作后过期 |

## 模型

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `GET /api/models` | 任意 | — | `{ catalog }`：与 `eevee model list` 相同的文本 |
| `POST /api/settings/models` | 任意 | `{ role?, provider, modelId }` | `{ ok }` |
| `POST /api/auth/:provider` | CLI | `{ key }` | `{ ok }` |

`role` 为 `router`、`worker`、`dreamer` 或 `default`，省略时为 `default`。

## 角色能力与 MCP

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `GET /api/capabilities` | 任意 | — | 能力视图 |
| `POST /api/capabilities/roles/:role` | 任意 | `{ extensions?, maxTurns? }` | 能力视图 |
| `POST /api/mcp/reload` | 任意 | — | 能力视图 |

`extensions` 是角色在自带扩展之外启用的完整列表，会替换原来的列表；名字必须已经安装。`maxTurns` 为正整数，`null` 恢复默认（不限制）。省略的字段保持不变。

能力视图：

| 字段 | 内容 |
|---|---|
| `available` | 可启用的扩展：`{ name, tools }` |
| `roles` | 每个角色：`{ role, builtIn, enabled, maxTurns? }` |
| `mcp` | 每个 MCP 服务器：`{ name, extension, state, exposure, tools, error? }` |
| `userExtensions` | 每个用户扩展文件：`{ file, name?, tools, error? }` |
| `problems` | `mcp.json` 里的配置问题 |

## 项目

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `POST /api/projects` | 任意 | `{ title, workspace }` | 项目摘要 |
| `GET /api/projects/:project/board` | 任意 | — | 看板 |
| `GET /api/projects/:project/usage` | 任意 | — | 花费 |

`POST /api/projects` 原样保存 `workspace`，不转换为绝对路径，也不检查目录是否存在；请传入已存在目录的绝对路径。

看板为 `{ tickets, openQuestions }`。`tickets` 的每一项是 `{ ticket, stage, reports, jobs }`：工单的全部字段、[阶段](tickets.md#工单阶段)、全部报告和运行中的后台作业。`openQuestions` 是尚未回答的问题。

花费为 `{ total, models, router, tickets }`。每份用量是 `{ input, output, cacheRead, cacheWrite, cost }`；`models` 以 `provider/modelId` 为键；`tickets` 的每一项是 `{ ticketId, title, usage }`。

## 对话

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `GET /api/projects/:project/conversation` | 任意 | — | Router 的对话视图 |
| `POST /api/projects/:project/messages` | 任意 | `{ text }` | `{ ok }` |
| `POST /api/projects/:project/conversation/retry` | 任意 | — | `{ ok }` |
| `GET /api/projects/:project/tickets/:ticket/conversation` | 任意 | — | Worker 的对话视图 |
| `POST /api/projects/:project/tickets/:ticket/messages` | 任意 | `{ text, mode? }` | `{ ok }` |
| `POST /api/projects/:project/tickets/:ticket/interrupt` | 任意 | — | `{ ok }` |
| `POST /api/projects/:project/tickets/:ticket/retry` | 任意 | — | `{ ok }` |
| `POST /api/projects/:project/questions/:question/answer` | 任意 | `{ answer }` | `{ ok }` |

- 给 Router 的消息唤醒它，忙时引导。
- 给 Worker 的消息 `mode` 为 `steer`（默认，引导）或 `followUp`（排队）。
- `retry` 重新运行以失败结束的那一轮；对话正在运行，或者上一轮没有失败时，返回 `409 conflict`。
- 回答问题后，答案投给问题所属的 Router 或 Worker。

对话视图为 `{ lines, running, failure? }`。`lines` 的每一项是 `{ id, role, text }`，`role` 为 `user`、`assistant`、`tool`、`notice` 或 `reset`；`failure` 是上一轮失败的原因。Router 的对话视图只含最新的 100 个条目，Worker 的只含最新的 200 个；需要完整记录或实时更新时用 [实时流](stream.md)。

## 记忆

| 接口 | 访问 | 请求体 | 响应 |
|---|---|---|---|
| `GET /api/projects/:project/memory/:scope/log` | 任意 | — | `{ commits }` |
| `GET /api/projects/:project/memory/:scope/commits/:commit` | 任意 | — | `{ diff }`：这次提交的改动 |
| `GET /api/projects/:project/memory/:scope/diff` | 任意 | — | `{ diff }`：还没提交的改动 |
| `POST /api/projects/:project/memory/:scope/revert` | 任意 | `{ commit }` | `{ ok }` |

`commits` 的每一项是 `{ commit, at, subject }`。`scope` 为 `global` 时操作全局记忆库，路径里的项目只用来定位接口。
