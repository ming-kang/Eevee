# 内置工具

这一页列出 Eevee 自带的工具和它们的参数。工具属于扩展，角色通过选用扩展获得工具，见 [配置角色能力](capabilities.md)。

| 工具 | 扩展 | `router` | `worker` | `dreamer` |
|:-:|:-:|:-:|:-:|:-:|
| [`read`](#read) | `eevee.resources` | ✓ | ✓ | ✓ |
| [`ticket`](#ticket) | `eevee.dispatch` | ✓ | | |
| [`ask_user`](#ask_user) | `eevee.dispatch` | ✓ | | |
| [`memory`](#memory) | `eevee.memory` / `eevee.memory-project` | ✓ | | ✓（只能整理项目记忆） |
| [`handoff`](#handoff) | `eevee.router` | ✓ | | |
| [`write`](#write) | `eevee.workspace` | | ✓ | |
| [`edit`](#edit) | `eevee.workspace` | | ✓ | |
| [`bash`](#bash) | `eevee.workspace` | | ✓ | |
| [`report`](#report) | `eevee.report` | | ✓ | ✓ |

另外，启用 `tool-search` 的角色有 `tool_search`，用来查找并加载延迟加载的工具；启用 `codemode` 的角色有 `codemode`，用来写脚本批量调用工具。

## read

按路径或[资源地址](addresses.md)读取，所有角色共用。

| 参数 | 说明 |
|---|---|
| `path` | 文件路径或资源地址，如 `draft.tex`、`ticket://t3`、`report://t3#2`、`memory://project/MEMORY.md` |
| `offset` | 从哪里开始读：文件为行号，`ticket://` 为第几项，`transcript://` 为条目编号，其余为字符位置 |
| `limit` | 读多少 |
| `query` | 只返回包含这段文本的行，比如对 `ticket://` 用 `[open]` 只看未结的工单。对 `transcript://` 只在当前这一页里过滤，见 [搜索](addresses.md#搜索) |

结果一律分页，并给出继续读取的位置。文件路径相对于工作目录，也可以是其他本地路径；图片文件会作为附件交给模型。

## ticket

Router 管理工单。`action` 决定做什么，其他参数按动作填写。除 `create` 外都需要 `ticketId`，且只能用于未结的工单。

| `action` | 参数 | 作用 |
|---|---|---|
| `create` | `title`、`goal`、`acceptance`；可选 `inputs`、`output`、`deliverTo`、`provider` 和 `modelId`（要么都填，要么都不填）、`modelReason` | 建单并启动 Worker。不指定模型时用 Worker 的默认模型；`deliverTo` 里的工单必须未结 |
| `message` | `text`；可选 `mode` | 给 Worker 追加指令。`mode` 为 `followUp`（默认，排队）或 `steer`（引导） |
| `interrupt` | — | 打断 Worker 当前这一轮，工单仍保持打开 |
| `review` | `verdict`、`note` | 处理 `ready` 报告。`accept` 结单为 `done`，`note` 写验收证据；`rework` 打回，`note` 写还缺什么 |
| `close` | `note` | 取消工单，结单为 `cancelled`，`note` 写原因 |
| `model` | `provider`、`modelId`；可选 `modelReason` | 给 Worker 换模型，从下一次模型请求起生效 |

| 参数 | 说明 |
|---|---|
| `ticketId` | 目标工单，如 `t3` |
| `title`、`goal` | 标题、要达成什么 |
| `inputs` | 输入文件路径或资源地址的数组 |
| `acceptance` | 验收标准的数组 |
| `output` | 产物写到哪里 |
| `deliverTo` | 验收后把结果投给这些工单，如 `["t1"]` |
| `provider`、`modelId`、`modelReason` | 模型和选择它的理由，见 `models://` |

## ask_user

Router 向你提一轮结构化问题。工具立即返回，不等待回答；你回答后，答案作为一条新消息送达。

| 参数 | 说明 |
|---|---|
| `items` | 问题数组，至少一题。每题有 `text`、`options`（可选答案，开放问题留空）和可选的 `recommended`（推荐答案） |
| `ticketId` | 可选。问题来自哪张工单的疑问；填写后答案直接投给那个 Worker |

## memory

写记忆并管理它的 Git 历史。改动在本轮结束时自动提交，见 [管理记忆](memory.md)。

| `action` | 参数 | 作用 |
|---|---|---|
| `edit` | `scope`、`file`、`oldText`、`newText` | 用原文替换。`oldText` 必须在文件里唯一匹配；找不到时失败并返回文件的最新内容 |
| `create` | `scope`、`file`、`content` | 新建文件；文件已存在时失败 |
| `log` | `scope` | 查看提交历史 |
| `diff` | `scope`；可选 `commit` | 查看一次提交的改动；不给 `commit` 时查看还没提交的改动（不含新建的文件） |
| `revert` | `scope`、`commit` | 撤销一次提交；与后来的改动冲突时放弃 |

`scope` 为 `project` 或 `global`。`global` 只允许改 `MEMORY.md`，只在你明确要求记住时使用。`dreamer` 的 `memory` 只能用 `project`。文件路径必须落在对应的记忆库里。

## handoff

Router 交接并重置自己的上下文。新的上下文是新开篇、交接小结和最近几轮原文，完整记录不受影响。

| 参数 | 说明 |
|---|---|
| `summary` | 交接小结：正在做什么、做了哪些决定、接下来要做什么 |

## write

在工作目录里写文件：文件不存在时新建，存在时覆盖，自动创建上级目录。

| 参数 | 说明 |
|---|---|
| `path` | 文件路径，相对于工作目录，也可以是绝对路径 |
| `content` | 文件内容 |

## edit

用原文替换修改一个文件。

| 参数 | 说明 |
|---|---|
| `path` | 文件路径，相对于工作目录，也可以是绝对路径 |
| `edits` | 替换数组，每项有 `oldText` 和 `newText`。每个 `oldText` 都按原文件匹配，必须唯一且互不重叠 |

## bash

在工作目录里执行 bash 命令，返回合并的 stdout 和 stderr。

| 参数 | 说明 |
|---|---|
| `command` | 要执行的命令 |
| `timeout` | 可选，超时秒数，超时后终止命令；转入后台后同样有效 |
| `background` | 可选，`true` 时直接转入后台，不等待前台输出 |

命令在前台运行超过 [`backgroundAfterMs`](settings.md)（默认 5 秒）会自动转入后台，返回作业地址 `job://jN`；命令结束后结果作为新消息唤醒 Worker。命令只继承基础环境变量，见 [环境变量](environment-variables.md#子进程继承的变量)。输出太长时保留结尾。

Windows 上使用 Git for Windows 自带的 bash。

## report

Worker 向 Router 提交报告。`progress` 以外的状态都会结束本轮，所以收尾报告要单独调用、放在最后。

| 参数 | 说明 |
|---|---|
| `status` | `progress`、`waiting`、`ready`、`blocked`、`failed` 或 `dropped`，见 [工单与报告](tickets.md#报告) |
| `summary` | 给 Router 的摘要，最多 600 字 |
| `artifacts` | 产物数组，每项有 `path` 和一句 `note` |
| `detail` | 可选，完整内容，Router 需要时再读 |
| `need` | 可选，`waiting` 时写明缺什么 |
| `questions` | 可选，需要你决定的问题，格式同 `ask_user` 的 `items` |
| `lessons` | 可选，值得长期记住的经验 |

报告编号在同一张工单内从 1 递增，地址为 `report://t3#2`。
