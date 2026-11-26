# 设计

本文档作为 Eevee 的高层设计，记录愿景、核心概念与关键取舍；具体实现以代码为准。

## 愿景

### 背景

一项长期工作往往由许多性质不同的子任务组成，以单一 Agent Session 为工作形态会遇到瓶颈：

1. **人的注意力有限**：单任务的上限取决于模型能力，多任务的上限取决于人的注意力。
2. **模型注意力涣散与串行阻塞**：长耗时任务（仿真、编译、测试）会阻塞前台对话，不同任务的中间过程混在同一上下文里也会拉低质量。
3. **长上下文成本**：超出 Prompt Cache TTL 后，持续增长的上下文会带来高昂的 `Input` / `CacheWrite` 开销。

### 设想

Eevee 是一个基于 `pi-durable` 构建的 Proactive Agent，Router 与 Worker 拥有不同工具与压缩策略：

- **`Router` / 调度者**：用户主对话入口，拥有只读工具（`read` / `ls` / `find` / `grep`）、协作工具与 `ask_user`，额外挂载二叉森林会话记忆。
- **`Worker` / 执行者**：长生命周期可复用的后台 Agent 会话，拥有读写工具（`read` / `write` / `edit` / `bash`）、`tasks`，以及 `message_router`。
- **`Ticket` / 工作项**：附属于某个 Worker 的轻量任务记录（`open` / `done` / `cancelled`），同一 Worker 完成后可保持空闲并继续承接新的 Ticket，复用对代码库的理解与热上下文。
- **用户可观测、可介入**：用户通常只与 Router 对话，但随时可以观察任意 Worker 的完整对话与后台任务日志，也可以直接发送引导或打断它。

### 原则

1. **占用人尽量少的注意力，产出尽量多的价值**：只在用户必须拍板、或有成果值得展示时主动打扰；其余时间保持安静。
2. **可观测、可控制**：每个 Worker、附属 Ticket 和后台任务都可实时观察、引导或中止。

## 核心概念

| 概念 | 代码名 | 定义 |
|:-:|:-:|---|
| 项目 | `Project` | 工作项目，可绑定多个工作目录，拥有独立的项目记忆与持久会话库 |
| 调度者 | `Router` | 用户对话主入口，使用只读工具、协作工具与二叉森林记忆 |
| 执行者 | `Worker` | 独立持久的后台 Agent 会话（`queued` / `running` / `idle` / `closed`） |
| 工作项 | `Ticket` | 附属于 Worker 的轻量工作记录（`open` / `done` / `cancelled`） |
| 忆者 | `Dreamer` | 独立静默运行，在后台将 Router 会话整理为可逐层展开的二叉森林 |

## 协作与流转

- **Worker 显式对话 Router**：Worker 可调用 `message_router` 向 Router 发送进展、结论或求助。
- **自然交棒兜底**：Worker 回合结束且无活跃后台 `tasks` 进入 `idle` 时，若本次 run 最后一轮工具调用未包含 `message_router`，系统自动把最终回复转交 Router（最后一轮已调用则不重复推送）；回合异常失败同样自动通知 Router。
- **后台静默**：只要 Worker 仍有运行中的后台 `tasks`，其状态保持 `running`，不打扰 Router 与用户；后台任务结束后自动唤醒该 Worker 继续处理。
- **用户提问**：只有 Router 持有 `ask_user`，非阻塞发起结构化问题，用户答复统一回到 Router。

## 记忆与压缩

- **Router（二叉森林会话记忆）**：原始消息完整保留，`Dreamer` 独立静默将历史摘要为完美二叉树节点；上下文达到阈值时以缓存前缀友好的方式折叠视图，需要细节时用 `zoom` 逐层下钻或用 `search` 检索原文。
- **Worker**：上下文压缩时复用实时对话前缀与 `sessionId` 命中 provider prompt cache，生成带文件操作清单的检查点摘要；遇 `overflow` 或异常自动回退 `pi-durable` 原生压缩。
- **项目记忆与模型画像**：均由用户维护并存储在 `engine.sqlite` 中；项目记忆注入 Router 与 Worker，模型画像注入 Router 辅助为 Worker 选型，修改后下一次请求生效。

## 数据归属

| 路径 | 归属 | 内容 |
|:-:|---|---|
| `auth.json` | `agent` / `engine` | Provider API Key 与 OAuth 凭据（与 Pi 发行版格式对齐） |
| `models.json` | `agent` / `engine` | 自定义 Provider、Model 定义与覆盖（与 Pi 发行版格式对齐） |
| `models-store.json` | `agent` / `engine` | 动态刷新的模型目录缓存 |
| `mcp-auth.json` | `agent` / `engine` | MCP OAuth 凭据与客户端注册信息 |
| `engine.sqlite` | `engine` | 项目列表（含多目录工作区）、项目记忆、模型画像、MCP 服务配置、全局策略与项目级工具/Skills/MCP 覆盖 |
| `projects/<id>/session.sqlite` | `core` | 单个项目的全部会话、Worker、Ticket、Question、后台任务与二叉森林记忆 |
| `projects/<id>/logs/` | `engine` | 后台任务持久化输出日志 |

删除项目只清理项目自身数据并停止其未完成工作，绝不触碰工作目录中的用户文件。

## 本地进程生命周期

后台运行时，Supervisor 只负责 Engine 子进程的生命周期，项目与会话仍由 Engine 托管。Engine 异常退出后由同一个 Supervisor 重启；用户停止通过停止请求文件与 IPC 传递，在 Windows 与 POSIX 上都走优雅关闭，不会被误判为崩溃。前台模式不启动 Supervisor。

Engine 启动后重新打开已有项目，复用持久会话的恢复机制继续未完成 run 和排队 Worker。运行状态与进程锁带 PID 属主，崩溃残留可被后续启动安全回收。
