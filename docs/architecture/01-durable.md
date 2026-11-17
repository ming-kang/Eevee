# 01 Pi-Durable 实现映射

本文记录 Eevee 当前如何把产品概念映射到 Pi-Durable。它是技术实现设计，不要求产品概念与 Durable 机制一一同名，也不要求未来所有实现细节保持不变。外部资料与源码调研见 [research/pi-durable.md](../research/pi-durable.md)。

| 概念 | Durable 里的做法 |
|:-:|---|
| 项目 | 一个 `Harness`，一个 SQLite（`openNodeSqliteStorage`） |
| `Router` | `harness.root()`，`agent` 为 `router` 角色；新项目先 `root.reset(开篇)` |
| 工单的执行对话 | 建单的 commit 里创建一个后台锚点任务，再创建归它所有的 `conversation`（示例 22 的 anchor 写法）。锚点任务立即结束，只充当归属者，Router 被打断、重置或等待空闲都波及不到执行对话。同一个 commit 里 `configure()` 角色、模型和工作目录；换模型也只是再 `configure()` 一次 |
| 角色能力 | 应用角色就是一次 `configure()`：`extensions` 为角色自带加用户启用的扩展（按需补上 `tool-search` / `codemode`），`tools: null` 选中它们的全部工具，再设 `instructions`、模型、工作目录和 `maxTurns`。`modelTools` 不动，`tool_search` 加载过的工具继续提供。`pi.agent` 里只存名字，运行时从 Registry 解析；扩展换了实现（比如 MCP 服务器连上后有了工具）不用重新配置 |
| MCP | Engine 级的 `McpHub`：每个服务器一个 `McpClient`，工具桥接为 `mcp__<服务器>__<工具>`，`deferred` / `callers: ["tools"]` 对应 `exposure`；`codemode` 的命名空间按服务器分组，随连接状态重建。输出超长时保留首尾，全文写到 `runtime/mcp-output/` |
| 工单、报告、问题 | `defineDoc()` / `defineDocFamily()` 文档；报告记录只追加，每 20 份存一次完整快照 |
| 投递 | 先 `route(event)` 得到投递指令；commit 之前取到目标对话的句柄。Durable 每个 commit 只允许一次 `submit(tx, draft)`，所以状态变更的 commit 只内联提交第一条，其余写进同一 commit 的持久 `Outbox`，之后逐条各用一个 commit 刷出，引擎启动时也补刷一次。需要唤醒空闲 Worker 的投递改写进 `WorkerQueue`，由引擎按并发槽位逐条提交；建单的开篇也走这条路。每条投递带确定的 `requestId`，重复提交会被去重 |
| 唤醒 / 不主动唤醒 | 提交 `input` / `write` 条目；引导、排队对应 `whenBusy: "steer"` / `"followUp"`。纯 `kind` / `data` 的 `write` 立即追加但模型看不到；带 `model` 的 `write` 等下一个对话边界进入模型视图，不自行启动新一轮 |
| 收尾报告 | `report` 工具在同一个 commit 里写入报告并向 Router 投递，`requestId` 取报告地址；收尾报告单独调用，并要求该工具轮的每次调用都返回 `control: { terminate: true }`，才能结束本轮 |
| 向用户提问 | `ask_user` 写入 `Question` 文档后立即返回；回答作为一条新消息唤醒对应对话。**不用挂起（park）的工具**：挂起的工具调用在回答之前一直不返回，这批工具调用结束不了，引导就一直进不来 |
| 上下文重置 | `handoff` / `report` 工具返回 `control: { handoff: 开篇 + 交接内容 }`，再加 `terminate: true` 结束本轮 |
| 未交报告的兜底 | `orchestration` 挂在生成任务上的 `afterRun` 钩子：绑定了工单的对话以最终回答（`reason: "answer"`）结束，说明没交收尾报告，启动一个任务补一份 `waiting`；`afterRun` 任务完成前对话仍算忙碌 |
| 运行失败的报告 | 运行失败时 `afterRun` 不会执行，所以由引擎的例行检查读执行对话的 `LiveDoc.runFailure`：重试用尽、超出 `maxTurns`、反复崩溃等记一份 `failed` 报告并唤醒 Router；中止、重置这类有意的结束不算。按失败那次运行的 `taskId` 去重，每次失败只报一次 |
| 记忆按轮提交 | `memory` 扩展的 `afterRun` 钩子；提交是幂等的，崩溃后钩子重跑也不会重复提交 |
| 后台作业 | Eevee 自己的 `bash` 工具通过执行环境启动命令，超过阈值就把进程交给引擎的作业表：在工具的 commit 里登记 `Job` 文档，输出续写到 `jobs/<jobId>.log`，结束后在同一个 commit 里结算并以 `input` 唤醒执行对话。进程只活在内存里，引擎重启时把仍为 running 的作业结算为 interrupted 并通知所属执行对话（不用挂起的工具） |
| 定时任务（Dreaming） | Router 对话名下的后台任务 `eevee.dream-timer`，每次醒来提交 `{ status: "sleeping", until }`，重启后照常继续。会话文档 `DreamLog` 记下上次整理的时间、各对话已整理到的条目和当前的整理工单；到期且有新记录时，在同一个 commit 里开出 `dreamer` 工单（经端口调用 `orchestration` 的建单，记忆模块不 import 它） |
| 花费 | `harness.usage()` 是整个项目的合计，`UsageDoc` 是每个对话自己的花费：Router 一份、每张工单一份 |
| 实时流 | `/api/stream` 转发 `conversation.watch()`：先发结构视图，再发把上一个值变成下一个值的 ops。Durable 在监听器忙时合并变更，套接字积压时监听器等它排空，所以慢客户端不会拖住引擎。客户端用 `ConversationTranscript` 拼完整记录，断线后以 `transcript.resume` 为窗口重新订阅，缺口用 `entries` 请求补齐 |

上下文的具体组织见 [02 上下文](02-context.md)，产品与协同行为见 [design/01 概念](../design/01-concepts.md) 和 [design/03 工单与调度](../design/03-orchestration.md)。
