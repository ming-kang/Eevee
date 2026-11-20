# DeepSeek Super-Agent

原文存档在 [dsh-superagent/](dsh-superagent/) 目录

---

## 一、《Super-agent 设计探索：迈向更自主的 Agent 系统》核心要点

### 1. 核心问题与四个基本特征

- **瓶颈从模型能力转向人的注意力**：单任务 Agent 已能较少依赖人工干预，但主流设计仍以单个 Session 为工作单位；一个人通常只能同时跟进 **3 到 5 个活跃 Session**。
- **打破 Session 与任务的绑定**：Session 应当退化为底层的系统实现细节，而非用户的认知负担。Super-agent 具备四个特征：
  1. **连续（Continuity）**：用户始终像在跟同一个 Agent 交互，无需关心“Session X 里有没有信息 Y”。
  2. **高效（Efficiency）**：多任务并发执行，无需等上一条耗时命令结束就能响应新指令。
  3. **主动（Proactivity）**：由环境事件（Trigger）驱动，值得处理时主动推进，无需介入时保持安静。
  4. **持久（Persistence）**：长期在线、接入真实工作环境，遇到异常能自动恢复。

### 2. 双层架构：常驻 Router 层 + 隔离 Worker 层

为了兼顾“全局上下文连续性”与“多任务并发吞吐”，将职责拆为两层：

- **Router 层（即本项目 `Router`）**：
  - 全局唯一的交互入口、序点、协调点与记忆入口。
  - **绝不亲自执行具体任务（甚至不配 `bash` 工具）**，只负责对外沟通与任务分派，使用较轻量的模型即可兼顾速度与效果。
  - **自然批处理（Batching）**：上一轮推理期间到达的多条 Trigger 会自动积压合并，在下一次 LLM 调用的 Prefill 阶段并行计算。压测显示：当 Trigger 到达率从 1 条/分钟升至 40 条/分钟时，平均 batch 从 1.0 升至 2.8，单次请求耗时仅从 2.5s 增至 3.9s，**单个决定分摊的推理时间从 6.4s 降至 1.6s**。因此单个常驻 Router Session 完全够用，无需过早分片而牺牲全局连续性。
- **Worker 层（即本项目 `Worker`）**：
  - 上下文彼此隔离，挂载完整执行工具，通常配置能力最强的模型专注单任务。
  - **绝不直接与人交互**，执行结果统一汇报给 Router 层，避免多会话各自回复造成混乱。

### 3. 事件驱动：两级过滤、订阅直通与 `Inline & Spill`

围绕环境事件（Trigger）从进入到处理的生命周期，采用四项计算机系统思想：

1. **两级过滤（Fast Path / Slow Path）**：
   - **程序层（Fast Path）**：用确定性代码检查事件来源、白名单与触发规则，直接滤除绝大多数噪音。
   - **语义层（Slow Path）**：只有候选事件才交给 LLM 按提示词策略判断。
2. **订阅与事件直通（Subscription & Direct Delivery）**：
   - 同一任务/PR/话题下的连续事件构成一条事件流（`Thread`）。
   - Router 根据初始事件创建 Worker 后，Worker 直接订阅该 `Thread`。**后续同一 `Thread` 下的事件由程序直通投递给该 Worker（Fast Path）**，无需再绕经 Router 调工具转发。
   - **消融实验（Section 7.1）**：在约 300 条消息（含 20 个工作请求）的测试中，Super-agent 完成时间 P50 为 12.4 分钟、P95 为 15.7 分钟，显著优于单 Session + Subagent 方案（中性提示词下从不调用 Subagent，P95 达 29.5 分钟；优先委派提示词下仍有概率觉得“活小自己干”而产生长尾阻塞）。去掉事件直通后，Router 决策次数增加约 **30%**，读缓存 token 从 2323 万增至 3177 万（增加约 **37%**）。
3. **上下文组织：`Inline & Spill` 与链式召回（`Chain of Recall`）**：
   - 把有限的上下文窗口当作 Cache 管理：
     - **Inline（内联）**：利用局部性原理，直接在窗口内放入当前对象 ID、简短摘要及紧密关联对象的 ID。
     - **Spill（溢出）**：超出长度上限或低频使用的完整内容留在窗口外，只留截断摘要与续读指针，供模型按需调工具读取。
   - **链式召回（Chain of Recall）**：每个注入或召回的对象都内联下一跳关联对象的 ID（如 `Trigger ↔ Thread ↔ Worker`），在底层构成一张**引用图**。Router 无需在窗口里塞满历史任务，遇到旧任务时顺着 ID 引用关系逐跳展开即可找回上下文。
4. **提前行动（投机执行 Speculative Execution）**：
   - 根据环境信号在后台提前尝试（如收到邀约先查日程起草回复、群里报 Bug 先静默复现寻找修复），有价值才交付，否则保持安静并丢弃。

### 4. 全双工交互、存算环境解耦与外部 Watchdog

- **全双工异步 ReAct Loop（`start` / `stop`）**：将耗时命令与子任务改为异步 `start()` / `stop()`，调用后立即返回 `Started` 释放当前推理步；后台完成后作为新事件投递回会话，使前台对话随时能响应新指令。
- **跨信道输出适配**：IM 聊天强调低打扰短回复（如限制单次不超过 100 词）；异步文档/PR 强调高信息密度与完整结构化交付。
- **计算、状态与执行环境解耦（BYOM）**：Agent Loop 计算与持久化会话状态分离，执行环境保留在用户本地机器（通过轻量机制按需执行命令并读取环境上下文）。
- **外部 Watchdog（看门狗）**：在主系统外设一个由定时消息驱动的独立 Watchdog 控制回路，不仅盯基础设施报错，还判断各 Worker 是否有实质进展、是否陷入死循环或偏离目标，发现异常及时介入修复。

---

## 二、`dsh-superagent-prototype` 原型实现要点

仓库代码是上述文章的部分落地原型，以 DeepSeek Harness 插件形式运行：

### 1. 设计哲学（[`docs/000-philosophy.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)）

> **占用尽量少的人的注意力，产出尽量多的价值。**

- 只在被请求、或明确规则允许时行动；干活时保持安静，只在需要人决策或有结果可用时才开口。
- **概念少、设置少**：业务需求优先变成现有概念的属性或提示词，不生造新概念。
- **面板默认安静（[`docs/005-panel.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md)）**：只凸显等待人处理的事，正常状态不占空间。

### 2. 工单、报告与工具边界（[`docs/001-domain.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[`003-execution.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)）

- **Ticket 独立于会话状态**：工单有自己的生命周期，每张工单对应一个执行会话（`worker-<ticket id>`）。
- **Report 状态枚举**：`progress`（进展）、`waiting`（等待）、`ready`（就绪待审）、`blocked`（受阻）、`failed`（失败）、`dropped`（无需处理）。
- **工单显示阶段**：按优先级从上往下取第一个匹配：投递失败 → 待回答 → 待审阅 → 受阻/失败 → 排队 → 闲置 → 工作中。
- **严格限制 Worker 工具**：Worker 只有 `orchestrator_read`、`orchestrator_ack`、`orchestrator_report` 等 6 个协同工具，**没有**向人提问（`ask_user_question`）、向人展示 UI（`present`）或派发其他会话的工具。
- **前台长命令自动转后台**：Worker 里的前台 shell 命令超过 5 秒自动转到后台，以便下一步能立刻收到新消息；Router 通过 `noWait` 拦截超过 5 秒的等待，防止阻塞新请求。
- **消息分级投递與分页**：
  - `worker_report`（含状态与最多 600 字摘要，超出部分附读取指针）和 `worker_attention` 会**唤醒**Router；
  - `ticket_ended`、设置保存等只注入记录、**不唤醒**Router；
  - 读取资源一律分页（文本默认 4000、最多 8000 字符；列表默认 20、最多 50 项）。
