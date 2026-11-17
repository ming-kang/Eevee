# 00 愿景与原则

## 背景

一项长期工作（比如写一篇光学论文或维护一个工程仓库）由许多性质不同的子任务组成：讨论思路、修改草稿、跑仿真、画图、查文献。

传统 Agent 以单一会话（Session）为基本工作单位，多线程只能多开会话并切换，会遇到三个瓶颈：

1. **人的注意力受限**：一个人通常只能同时跟进 3 到 5 个活跃会话；单任务的上限取决于模型能力，多任务的上限取决于人的注意力。
2. **模型注意力涣散与串行阻塞**：单会话里长耗时任务（如跑仿真、编译）会阻塞前台对话，不同任务的中间细节混在一起也会拉低模型表现。
3. **长上下文成本**：上下文无限膨胀后，一旦缓存失效，重读整段历史的输入成本远高于缓存读取。

## 设想

Eevee 是一个基于 Pi-Durable 的 Proactive Agent。会话退化为底层实现细节，用户面对的是一个持续工作的助手：

- **`Router` / 调度者**：像机场塔台与运控中心，是用户的主要对话入口，负责理解目标、统筹规划、安排优先级、建工单、处理报告和验收，不亲自执行耗时工作。
- **工单（`Ticket`）**：一项独立工作的协调外壳，记录目标、输入、验收与产物，不规定执行步骤。
- **`Worker` / 执行对话**：每张工单绑定一个持续的 Worker 会话。Worker 在角色能力配置内拥有完整执行自由，可以使用文件、命令、MCP 等能力，也可以管理自己的后台作业和内部子任务。
- **报告（`Report`）**：Worker 与 Router 之间的自动协同接口。正常结果由 Report 回流，Router 不需要逐条转述执行细节。
- **记忆（`MemoryDrive`）**：跨任务有用的经验存入 Git 记忆仓库，需要时可读、可改、可撤销。

用户通常只与 Router 对话，但可以随时观察 Worker 的完整执行过程，直接发送引导或打断它。Worker 不独立向用户推送通知，自动协调仍通过 Router 汇总。

### 示例：论文项目

1. 用户新建项目“光学论文《xxx》”，系统创建项目存储与 Git 记忆仓库。
2. Router 建立 Ticket 1“打磨论文草稿”，T1 的 Worker 开始工作。
3. T1 发现缺少仿真数据，交一份 `waiting` 报告写明需要什么。Router 建立 Ticket 2“运行仿真”，并指定 T2 的结果交给 T1。仿真参数需要用户拍板时，Router 先用 `ask_user` 提问，之后照常处理其他事情。
4. T2 启动两小时仿真，命令转入后台，Worker 本轮结束、不占推理；仿真结束后作业结果唤醒 T2 处理数据，交 `ready` 报告。
5. Router 验收 T2 后，引擎把 T2 的报告和产物投给 T1，T1 继续推进论文打磨，不需要 Router 转述。

## 原则

1. **占用尽量少的人的注意力，产出尽量多的价值**：只在用户必须做决定、或者有成果值得展示时才通知；干活时保持安静（参考 [`dsh-superagent-prototype` 理念](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)）。
2. **YOLO**：不设置逐命令审批，Ticket 和 Report 用于协同。
3. **减少认知负担**：新需求优先考虑能否复用现有概念。
4. **状态写进存储，不只留在上下文里**：任何 `reset` 后还需要的信息（工单、依赖、待回答的问题）都必须是持久化状态，模型的上下文只是它的一个视图。
5. **可观测、可控制**：默认安静不等于隐藏过程。每个工单、Worker 和后台作业都能查看，用户随时可以中止或介入。

正常路径由引擎自动流转；意外情况交给 Router；只有必须由用户决定的事情才打扰用户。不为异常预先发明一套领域规则。

## 当前边界

上下文组织、缓存、压缩和 Dreaming 都是可替换的实现策略；设计阶段只稳定它们要满足的产品目标。

## 参考来源

- 双层架构与工单调度：DeepSeek 《Super-agent 设计探索》 与 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
- 持久化原语与缓存机制：[Pi-Durable](https://github.com/earendil-works/pi) 与 [DS-Bot](https://github.com/Fei2411/DS-Bot)
- 记忆仓库与 Dreaming：Cognition [Memory and dreaming](https://devin.ai/blog/memory-and-dreaming) 与 [Agent Memory Repo 规范](https://cognition.com/agent-memory-repo)
