# Pi-Durable

[packages/durable](https://github.com/earendil-works/pi)

Pi-Durable 是一个"持久化"的 agent 运行框架

## 相关能力

| 能力 | 说明 | 出处 |
|:-:|---|---|
| Harness / Conversation / Entry / Commit | Harness 是存储加运行 agent 的机制；对话是一串不可变的条目；所有改动都是原子提交 | README "Concepts" |
| 多个对话、fork、对话的所属关系 | `createConversation`、`fork`；对话可以属于某个 task | README "More Conversations and Forks"、"Abort and Subagents" |
| 后台常驻子代理 | Worker 属于一个后台 anchor 任务，Router 停止或等待空闲都不会波及它。reporter 任务负责投递消息，并把回答回传给 Router，用 `requestId` 保证只投递一次 | `test/examples/22-subagent-background.ts` |
| 前台子代理 | 可重放的子代理工具，界面可以通过 `details` 跳到 Worker | `test/examples/21-subagent-foreground.ts` |
| 按会话配置 | `configure()`，可配置 `model`、`thinkingLevel`、`extensions`、`tools`、`modelTools`、`instructions`、`cwd`、`maxTurns`、`compaction` | README "Per-Conversation Agent" |
| 忙碌时提交 | `steer` / `followUp` / `reject`；`write` 只追加记录，不询问模型；`continue` 让中断的运行接着跑 | README "Busy Conversations" |
| 重置与交接 | `reset(text)` 让模型从这段文字重新开始，旧记录仍留在存储里；工具可以返回 `control: { handoff }` | README "Reset and Handoff" |
| 压缩 | 可自动，也可手动；参数可以按模型、按会话覆盖；`beforeCompact` 钩子可以拒绝压缩，或自己提供摘要 | README "Compaction" |
| 钩子 | `beforeRequest`、`beforeProviderRequest`、`afterResponse`、`onYield`、`afterTools`、`afterRun`、`beforeTool`、`afterTool` | README "Hooks" |
| Signal 与睡眠 | `defineSignal`；任务可以睡到某个时间点、等某个 signal，或两者都等；睡眠期间不占进程，重启后照常继续 | README "Sleeping and Waking Up"、"Signals"；示例 38、39 |
| 挂起的工具 | 工具返回挂起状态，醒来后重新执行；可用于等 webhook、轮询、并行子任务、等子代理回答 | README "Tools that park"；示例 40–43 |
| 审批关卡 | `beforeTool` 返回睡眠状态，等待审批 signal | 示例 44 |
| onYield 评审 | 由评审任务决定回答算不算数，返回 `{ continue }` 即打回 | 示例 45 |
| 自定义文档 | `defineDoc()`，和条目在同一次提交里修改；可以延迟落盘 | README "Your Own State" |
| Watch | 对话视图的实时更新（ops）；`ConversationTranscript` 支持分窗口加载、补齐缺口和断线续传 | README "Watching a Conversation"；示例 31 |
| 任务图 | `watchTaskGraph()` | README "Task Graph" |
| 花费 | `pi.usage` 文档、`harness.usage()` | README "Usage and Cost" |
| 提供方会话身份 | 每个对话有自己的 UUIDv7，作为 `sessionId` 传给 pi-ai，用于缓存亲和；Worker 和 fork 会拿到新的 UUIDv7 | README "Persist and Resume" |
| 存储 | Memory、IndexedDB、SQLite（Node 上用 `node:sqlite`）、JSONL、Cloudflare DO；**同一时刻只能有一个进程写同一个存储** | README "Storage" |

## 关键事实

- 总结请求使用独立的系统提示词 `SUMMARIZATION_SYSTEM_PROMPT`，把对话序列化成 `<conversation>` 文本，并设置 `cacheRetention: "none"`（`src/harness/compaction.ts:173-183`）
- **系统提示词由多个段落组成**，每次请求前渲染，只重新发送有变化的部分。README 提醒：每次内容都会变的段落（比如当前时间）会让缓存失效。
- **`instructions` 作为最后一个段落渲染进系统提示词。**