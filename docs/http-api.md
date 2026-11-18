# HTTP 接口

这一页列出 Engine 的全部 HTTP 接口。

关于如何找到 Engine、拿到 token 并发出第一个请求，见 [接入本地接口](integration.md)；接口的完整类型定义在 `src/api/contract.ts`。

## 约定

- 地址为 `http://127.0.0.1:<port>`，端口见 `runtime/engine.json`。`Host` 和 `Origin`（若有）必须是回环地址。
- 请求体和响应体都是 JSON，请求体最大 1 MB。
- 除 `GET /api/health` 和 `POST /api/session`，所有接口都要在 `x-eevee-token` 请求头中携带鉴权 token，见 [鉴权](integration.md#鉴权)。
- 路径里的 `:project` 是项目编号（如 `p3f9a1c2e`），`:ticket` 是工单编号（如 `t3`），`:question` 是问题编号（如 `q2`），`:job` 是后台作业编号（如 `j7`），`:scope` 是 `project` 或 `global`，`:role` 是 `router`、`worker` 或 `dreamer`。路径参数要做 URL 编码，比如记忆文件 `notes/sim.md` 写成 `notes%2Fsim.md`。
- 没有数据要返回的接口，响应为 `{ "ok": true }`，下表写作 `{ ok }`。

## 错误

失败时返回对应的状态码和 `error`：`code` 说明是什么问题，同一层里的其他字段是它的参数，`message` 是 Engine 的中文措辞。只想打印的客户端用 `message`；要用自己的语言或界面表达的，按 `code` 和参数措辞。

```json
{ "error": { "code": "ticket_closed", "ticketId": "t3", "message": "t3 已经结单" } }
```

| 状态 | `code` | 参数 | 含义 |
|:-:|:-:|:-:|:-:|
| 400 | `bad_json` | — | 请求体不是合法的 JSON |
| 400 | `required` | `field` | 字段为空 |
| 400 | `invalid` | `field`、`allowed?` | 字段不合法；`allowed` 是可选的取值 |
| 401 | `unauthorized` | — | 缺少 token 或 token 无效 |
| 401 | `bad_code` | — | 授权码无效或已过期 |
| 403 | `forbidden_host` | — | 请求不是发往回环地址，或 `Origin` 不是回环地址 |
| 404 | `no_route` | `method`、`path` | 没有这个接口 |
| 404 | `no_file` | — | 面板没有这个文件 |
| 404 | `no_project` | `projectId` | 项目不存在 |
| 404 | `no_ticket` | `ticketId` | 工单不存在 |
| 404 | `no_worker` | `ticketId` | 工单没有执行对话 |
| 404 | `no_question` | `questionId` | 问题不存在 |
| 404 | `no_job` | `jobId` | 后台作业不存在 |
| 404 | `no_memory_file` | `file` | 记忆文件不存在，或路径在记忆库之外 |
| 404 | `no_commit` | `commit` | 记忆库里没有这个 commit |
| 404 | `no_model` | `provider`、`modelId` | 模型不存在 |
| 404 | `no_provider` | `provider` | provider 不存在 |
| 404 | `no_extension` | `names` | 要启用的扩展没有安装 |
| 409 | `model_unset` | `role` | 角色没有可用的模型 |
| 409 | `ticket_closed` | `ticketId` | 工单已经结单 |
| 409 | `report_changed` | `ticketId` | 待验收的报告已经被新的报告取代 |
| 409 | `answered` | `questionId` | 问题已经回答过 |
| 409 | `job_ended` | `jobId` | 后台作业已经结束 |
| 409 | `running` | — | 对话正在运行 |
| 409 | `not_failed` | — | 上一轮没有失败，不需要重试 |
| 409 | `revert_failed` | `commit` | 撤销失败：没有这个 commit，或与后来的改动冲突；仓库不变 |
| 413 | `too_large` | — | 请求体超过 1 MB |
| 500 | `internal` | `detail` | 意料之外的错误，`detail` 是它的原话，详情写进 Engine 日志 |

## Engine

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `GET /api/health` | — | `{ ok }` |
| `GET /api/status` | — | `{ bootId, version, port, projects }` |
| `POST /api/shutdown` | — | `{ ok }`，随后 Engine 退出 |

`projects` 是项目摘要的数组：`{ id, title, workspace, createdAt, activeAt, models? }`。`activeAt` 是项目最近一次活动（对话、工单、报告、问题或后台作业的变化）的毫秒时间戳。

## 授权

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `POST /api/session/code` | — | `{ code }`：90 秒内有效的一次性授权码 |
| `POST /api/session` | `{ code }` | `{ token }`：与 `runtime/token` 相同的 token |

## 模型

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `GET /api/models` | — | 模型视图 |
| `POST /api/settings/models` | `{ role?, provider, modelId, thinkingLevel? }` | `{ ok }` |
| `POST /api/auth/:provider` | `{ key }` | `{ ok }` |

`role` 为 `router`、`worker`、`dreamer` 或 `default`，省略时为 `default`。`thinkingLevel` 为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`，省略时为 `off`。

模型视图：

| 字段 | 内容 |
|:-:|:-:|
| `catalog` | 默认模型、可用模型和使用经验的文本，格式与 `read models://` 相同，但默认模型一栏是全局设置 |
| `defaults` | `settings.json` 里的默认模型：`{ default?, router?, worker?, dreamer? }`，每项为 `{ provider, modelId }` |
| `routerModel` | Router 实际使用的模型，没有配置时省略 |
| `providers` | 每个 provider：`{ id, name, configured, authType?, source?, custom, modelCount }`。`configured` 表示有可用的凭据，`authType` 为 `api_key` 或 `oauth`，`source` 说明凭据从哪里来，`custom` 表示来自 `models.json` |
| `available` | 有凭据的 provider 下的模型：`{ provider, modelId, name, contextWindow, maxTokens, reasoning, thinkingLevels, cost, cacheShortSeconds? }`，`thinkingLevels` 是它支持的思考档位，不支持推理时为 `["off"]`，`cost` 是每百万 token 的 `{ input, output, cacheRead, cacheWrite }` 美元价格 |
| `profiles` | `models.md` 的内容 |
| `problems` | `models.json` 里的[配置问题](#配置问题) |

## 角色能力与 MCP

| 接口 | 请求体 | 响应 |
|---|:-:|:-:|
| `GET /api/capabilities` | — | 能力视图 |
| `POST /api/capabilities/roles/:role` | `{ extensions?, maxTurns? }` | 能力视图 |
| `POST /api/mcp/reload` | — | 能力视图 |

`extensions` 是角色在自带扩展之外启用的完整列表，会替换原来的列表；名字必须已经安装。`maxTurns` 为正整数，`null` 恢复默认（不限制）。省略的字段保持不变。

能力视图：

| 字段 | 内容 |
|:-:|:-:|
| `available` | 可启用的扩展：`{ name, tools }` |
| `roles` | 每个角色：`{ role, builtIn, enabled, maxTurns? }` |
| `mcp` | 每个 MCP 服务器：`{ name, extension, state, exposure, tools, error? }` |
| `userExtensions` | 每个用户扩展文件：`{ file, name?, tools, error? }` |
| `problems` | `mcp.json` 里的[配置问题](#配置问题) |

### 配置问题

`problems` 的每一项是 `{ file, entry?, code, … }`：哪个文件、文件里的哪个 provider 或 MCP 服务器、是什么问题，其余字段是参数。有问题的条目被跳过，其他照常加载。MCP 服务器和用户扩展的 `error` 格式相同，但不带 `file` 和 `entry`。

| `code` | 参数 | 含义 |
|:-:|:-:|:-:|
| `schema` | `path`、`detail` | 不符合格式；`detail` 是校验器的原话 |
| `shape` | `expected` | 整个文件的结构不对 |
| `invalid` | `field`、`allowed?` | 字段不合法 |
| `needs_models` | — | 新增的 provider 没写 `models` |
| `unsupported_api` | `model`、`api` | 模型的 `api` 不受支持 |
| `needs_api` | `model` | 模型没有指定 `api` |
| `needs_base_url` | `model` | 模型没有 `baseUrl` |
| `no_auth` | — | provider 没有可用的认证方式 |
| `env_unset` | `name` | `name` 引用的环境变量没有设置 |
| `name_taken` | `name` | 另一个扩展文件已经用了这个名字 |
| `name_reserved` | `name` | 扩展名是 Eevee 保留的 |
| `bad_export` | — | 默认导出不是 extension，也不是返回 extension 的函数 |
| `disconnected` | — | MCP 服务器的连接断开了 |
| `failed` | `detail` | 其他错误，`detail` 是它的原话，比如 MCP 服务器启动失败、扩展文件抛出的错误 |

## 项目

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `POST /api/projects` | `{ title, workspace }` | 项目摘要 |
| `POST /api/projects/:project/models` | `{ role?, model }` | 项目摘要 |
| `GET /api/projects/:project/board` | — | 看板 |
| `GET /api/projects/:project/usage` | — | 花费 |

`POST /api/projects` 原样保存 `workspace`，不转换为绝对路径，也不检查目录是否存在；请传入已存在目录的绝对路径。

`POST /api/projects/:project/models` 设置这个项目某个角色的模型，写进 `project.json`，立即应用到 Router 和没有指定模型的工单。`model` 为 `{ provider, modelId, thinkingLevel? }`，`null` 去掉项目自己的设置、回到全局默认；`role` 同上。

看板为 `{ tickets, openQuestions, router }`。`tickets` 的每一项是 `{ ticket, stage, reports, jobs }`：工单的全部字段、[阶段](tickets.md#工单阶段)、全部报告和运行中的后台作业。`openQuestions` 是尚未回答的问题。`router` 为 `{ running, failure? }`：Router 是否正在运行，以及上一轮怎样失败；被打断、交接重置不算失败。`failure` 为 `{ reason, detail? }`，`reason` 是 Durable 的失败原因（如 `model_error`、`turn_limit`），`detail` 是 provider 或运行时的原话，由调用方自己措辞。

花费为 `{ total, models, router, tickets }`。每份用量是 `{ input, output, cacheRead, cacheWrite, cost }`；`models` 以 `provider/modelId` 为键；`tickets` 的每一项是 `{ ticketId, title, usage }`。

## 对话

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `GET /api/projects/:project/conversation` | — | Router 的对话视图 |
| `POST /api/projects/:project/messages` | `{ text }` | `{ ok }` |
| `POST /api/projects/:project/conversation/retry` | — | `{ ok }` |
| `GET /api/projects/:project/tickets/:ticket/conversation` | — | Worker 的对话视图 |
| `POST /api/projects/:project/tickets/:ticket/messages` | `{ text, mode? }` | `{ ok }` |
| `POST /api/projects/:project/tickets/:ticket/interrupt` | — | `{ ok }` |
| `POST /api/projects/:project/tickets/:ticket/retry` | — | `{ ok }` |
| `POST /api/projects/:project/questions/:question/answer` | `{ answer }` | `{ ok }` |

- 给 Router 的消息唤醒它，忙时引导。
- 给 Worker 的消息 `mode` 为 `steer`（默认，引导）或 `followUp`（排队）。
- `retry` 重新运行以失败结束的那一轮；对话正在运行时返回 `409 running`，上一轮没有失败时返回 `409 not_failed`。
- 回答问题后，答案投给问题所属的 Router 或 Worker。

对话视图为 `{ lines, running, failure? }`。`lines` 的每一项是 `{ id, role, text }`，`role` 为 `user`、`assistant`、`tool`、`notice` 或 `reset`；`failure` 是上一轮怎样失败，格式同看板的 `router.failure`。Router 的对话视图只含最新的 100 个条目，Worker 的只含最新的 200 个；需要完整记录或实时更新时用 [实时流](stream.md)。

## 后台作业

| 接口 | 请求体 | 响应 |
|:-:|:-:|:-:|
| `GET /api/projects/:project/jobs/:job/log` | — | `{ job, content, truncated }` |
| `POST /api/projects/:project/jobs/:job/kill` | — | `{ ok }` |

- `log` 返回作业的状态和日志尾部：最近 200 行，最多 64 KB；截掉了前面的内容时 `truncated` 为 `true`。完整日志在 `projects/<project>/jobs/<job>.log`。
- `kill` 终止一个运行中的作业，等它的状态和日志落定后才返回。所属工单还开着时，Worker 会收到作业已终止的通知。作业已经结束时返回 `409 job_ended`。

## 记忆

| 接口 | 请求体 | 响应 |
|:-:|---|:-:|
| `GET /api/projects/:project/memory/:scope/log` | — | `{ commits }` |
| `GET /api/projects/:project/memory/:scope/files` | — | `{ files }` |
| `GET /api/projects/:project/memory/:scope/files/:file` | — | `{ path, content }` |
| `GET /api/projects/:project/memory/:scope/commits/:commit` | — | `{ diff }`：这次提交的改动 |
| `GET /api/projects/:project/memory/:scope/diff` | — | `{ diff }`：还没提交的改动 |
| `POST /api/projects/:project/memory/:scope/revert` | `{ commit }` | `{ ok }` |

`commits` 的每一项是 `{ commit, at, subject }`。`files` 的每一项是 `{ path, size }`，`path` 是相对记忆库的路径，用 `/` 分隔，`MEMORY.md` 排在最前；读取文件时 `:file` 就是这个路径，超出记忆库或指向 `.git` 的路径返回 `404`。`scope` 为 `global` 时操作全局记忆库，路径里的项目只用来定位接口。
