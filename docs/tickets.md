# 工单与报告

工单是 Router 交给 Worker 的一项独立工作。这一页说明工单怎样从建立走到结单、报告的各种状态是什么意思，以及 Engine 在什么情况下自动推进。总的规则是：**正常路径自动流转，意外情况交给 Router，确有必要由人介入**。

## 工单包含什么

Router 用 `ticket` 工具的 `create` 动作建单（下文简写为 `ticket create`，其他动作同理；它们是 Router 的工具，不是命令行命令），写明：

| 字段 | 含义 |
|:-:|:-:|
| 标题、目标 | 要完成什么，必填 |
| 输入 | 可选，文件路径或资源地址，比如 `draft.tex`、`report://t2` |
| 验收标准 | 怎样算做完，必填 |
| 产物位置 | 可选，有明确产物时写明放在哪里 |
| `deliverTo` | 可选，验收后把结果直接投给哪些工单 |
| 模型 | 可选，不填就用 Worker 的默认模型，见 [选择模型](models.md#工单的模型) |

工单不规定执行步骤。Worker 在目标之内自主决定怎么做，可以拆分步骤、运行后台命令、使用为它启用的工具。

工单编号形如 `t1`、`t2`，按项目递增。工单只有三种状态：`open`、`done`（验收通过）和 `cancelled`（被取消）。

## 生命周期

1. Router 建立工单，Engine 为它创建 Worker 对话，把开篇作为第一条消息发给它。
2. Worker 工作，期间可以交中途报告（`progress`）。
3. Worker 交一份收尾报告，本轮结束，Router 被唤醒。
4. Router 根据报告处理：
   - `ready`：用 `ticket review` 验收，`accept` 必须附证据（测试输出、改动的文件、检查结果），记为工单的结单说明；`rework` 写明还缺什么，Worker 接着做。
   - `waiting`：补上缺的材料，或者建一张新工单去取，并让新工单的结果投给它。
   - `blocked`、`failed`、`dropped`：决定是用 `ticket message` 调整后继续，还是用 `ticket close` 取消。
5. 工单结单后，Worker 对话随之结束，仍在运行的后台作业被终止。

工单打开期间，Router 还可以用 `ticket message` 追加指令、用 `ticket interrupt` 打断当前这一轮、用 `ticket model` 给它换模型或思考档位。

## 报告

| 状态 | 类别 | 含义 | Worker | Router |
|:-:|:-:|:-:|:-:|:-:|
| `progress` | 中途 | 有阶段性进展 | 继续这一轮 | 不唤醒 |
| `waiting` | 收尾 | 缺少材料，在 `need` 里写明 | 结束这一轮 | 唤醒 |
| `ready` | 收尾 | 做完了，等待验收 | 结束这一轮 | 唤醒 |
| `blocked` | 收尾 | 无法继续 | 结束这一轮 | 唤醒 |
| `failed` | 收尾 | 失败 | 结束这一轮 | 唤醒 |
| `dropped` | 收尾 | 发现不需要做 | 结束这一轮 | 唤醒 |

投给 Router 的是状态、600 字以内的摘要、`need`、需要决定的问题、产物、经验和报告地址。`detail` 不投递，Router 需要时用 `read report://t3#2` 读取。

报告是结构化的：要你决定的问题写进 `questions`，值得长期记住的经验写进 `lessons`。Router 能自己回答就直接 `ticket message`，否则带上工单编号向你提问；Router 和 Dreaming 会从 `lessons` 里提炼记忆。

### Engine 补交报告

- **没交收尾报告**：Worker 的一次运行以普通回答结束、又没有后台作业在跑时，Engine 用它最后的回答补交一份 `waiting`。
- **运行失败**：重试用尽、超出 [轮次上限](capabilities.md#限制每次运行的轮次) 等失败，Engine 记一份 `failed`，摘要写明原因，并提示 Router 可以用 `ticket message` 让它继续或取消工单。你或 Router 主动打断、重置这类有意的结束不算失败。

Engine 补交的报告带 `origin`：没交报告时为 `{ type: "no-report", answered }`，`answered` 表示摘要是否是 Worker 的最后回答；运行失败时为 `{ type: "run-failed", failure }`，`failure` 同看板的 [`router.failure`](http-api.md#项目)。面板据此用你选的语言显示原因，摘要和 `need` 是写给 Router 的。

## 工单阶段

面板和 `eevee project board` 给每张工单显示一个阶段。阶段由最新报告和运行情况推导，按下表从上往下取第一个符合的。阶段只对 `open` 工单有意义；看板也会列出已结单的工单，它们通常显示为 `idle`。

| 阶段 | 条件 | 需要谁 |
|:-:|:-:|:-:|
| `answer` 待回答 | 有属于它、尚未回答的问题 | 用户 |
| `review` 待验收 | 最新收尾报告是 `ready`，尚未处理 | Router |
| `blocked` 受阻 | 最新收尾报告是 `blocked`、`failed` 或 `dropped`，尚未处理 | Router |
| `queued` 排队中 | 在等并发槽位 | — |
| `working` 执行中 | Worker 正在运行 | — |
| `jobs` 后台作业 | 这一轮已结束，但有后台作业在跑 | — |
| `waiting` 等待中 | 最新收尾报告是 `waiting` | Router 或依赖的工单 |
| `idle` 空闲 | 其他情况 | — |

Router 对工单采取相关的 `ticket` 动作、为它提问，或者新建一张 `deliverTo` 包含它的工单，就算处理了它最新的收尾报告。

## 主动提醒

未处理的收尾报告是 Router 的持久待办，不依赖对话里是否还记得。一份收尾报告超过 [`reminderAfterMs`](settings.md)（默认 30 分钟）仍未处理时，Engine 提醒 Router 一次。

## 依赖与投递

工单之间用 `deliverTo` 传递结果。例如论文工单 `t1` 缺仿真数据，交了一份 `waiting`；Router 建立仿真工单 `t2`，`deliverTo` 设为 `t1`。Router 建 `t2` 时，`t1` 那份 `waiting` 就算作已处理；`t2` 验收通过后，Engine 把它的报告地址、摘要和产物直接投给 `t1`。

如果被等待的工单被取消，Engine 会唤醒 Router 重新安排。

### 投递规则

所有事件都按同一张表决定投给谁、怎么投。**唤醒**会在对方空闲时开始新的一轮，忙时按表中注明的方式进入：**引导**在当前这批工具调用结束后立即被看到，**排队**等这一轮结束后再开始；表中没有注明的都是忙时排队。**记录**只把消息写进对话，不启动新的一轮。

| 事件 | 目标 | 方式 |
|:-:|:-:|:-:|
| 你在主对话发言 | Router | 唤醒（忙时引导） |
| 收尾报告 | Router | 唤醒（忙时排队） |
| 中途报告 | Router | 记录 |
| 新建工单的开篇 | 新的 Worker | 唤醒，等并发槽位 |
| Router 用 `ticket message` 或 `review rework` | 那个 Worker | 唤醒（`message` 默认排队） |
| 工单验收通过，且 `deliverTo` 不为空 | `deliverTo` 里的每个 Worker | 唤醒；Router 只记录 |
| 工单被取消，且有工单在等它 | Router | 唤醒 |
| 你回答了问题 | 问题属于 Router 时投给 Router；属于工单时投给那个 Worker | 唤醒（忙时引导）；属于工单时 Router 另外记录 |
| 后台作业结束 | 所属的 Worker | 唤醒 |
| Engine 重启打断了后台作业 | 所属的 Worker | 唤醒，提醒先检查目录和 git 状态再决定是否重跑 |
| 整理工单的报告 | Router | 记录；`ready` 自动验收 |
| 收尾报告超时未处理 | Router | 只在 Router 空闲时唤醒；每份报告只提醒一次 |
| 上下文超过阈值 | Router | 唤醒，请它交接 |
| 你直接给 Worker 发消息 | 那个 Worker | 唤醒（默认引导）；Router 记录这次介入 |
| 你在面板打断 Worker | Router | 记录 |

## 并发

[`maxActiveWorkers`](settings.md)（默认 3）限制同时运行的 Worker 数量，超出的工单显示为 `queued`，等有空位时再开始。Router 不占槽位，整理工单和普通工单一样占槽位。Worker 结束本轮、只剩后台作业在跑时，会释放槽位。槽位按唤醒计算：除了你直接发给 Worker 的消息，唤醒空闲 Worker 的投递都要等槽位，包括新工单的开篇、`ticket message`、返工、`deliverTo` 投递、问题的答案和后台作业结束的通知；Worker 正在运行时，这些消息不另占槽位，按上表引导或排队。所以你回答了工单的问题之后，它也可能先显示为 `queued`。你直接发给 Worker 的消息不等槽位，不受这个上限限制。

## 后台作业

Worker 的 `bash` 命令运行超过 [`backgroundAfterMs`](settings.md)（默认 5 秒），或者 Worker 明确要求后台执行时，命令转入后台：

- `bash` 立即返回作业地址，比如 `job://j7`；
- 完整输出续写到 `projects/<project>/jobs/j7.log`，任何对话都可以用 `read job://j7` 查看状态和输出；
- Worker 可以先结束本轮，命令结束后结果作为新消息唤醒它；这时不会补 `waiting` 报告。

你可以在面板的作业标签里，或者用 [HTTP 接口](http-api.md#后台作业) 终止单个作业，所属的 Worker 会收到作业已终止的通知。工单结单时，它仍在运行的作业会被终止，不再通知。Engine 重启时，仍在运行的作业记为被打断，并通知所属的 Worker。

## 上下文重置

Worker 交收尾报告时，如果上下文已经超过模型窗口的 [`handoffThreshold`](settings.md)（默认 60%），会顺带重置：之后的上下文从新的开篇开始，开篇里包含工单内容和刚交的报告。完整记录不受影响，面板上仍是一条连续的对话。见 [Eevee 如何工作](how-eevee-works.md#重置)。
