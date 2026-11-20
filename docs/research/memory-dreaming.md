# Memory 与 Dreaming

本笔记汇总与 Agent 记忆及 Dreaming 相关的核心参考材料：以 **Cognition 的 Devin Memory & Dreaming（及 Agent Memory Repo 规范）** 为主方案，辅以 Anthropic 关于 Agent 记忆边界的实验结论。

---

## 一、Cognition：Memory and Dreaming

出处：[Memory and dreaming: how Devin learns from working with you](https://devin.ai/blog/memory-and-dreaming) 与 [Devin Memory 产品指南](https://docs.devin.ai/product-guides/memory)。

### 1. 记忆的定位

- **记忆不是会话摘要（not summaries of sessions）**，而是从与用户合作中学到的经验教训，写成简短的笔记，并附带指向学到它的那个会话的链接。
- **记什么**：个人偏好、用户的纠正、带理由的项目/架构决定、摸索出来的环境坑（gotchas）。
- **不记什么**：单次会话摘要、任务状态（如 PR 编号或工单进度）、随时能从代码里重新查到的事实、密钥与凭据。
- **记忆与技能（Skills）的区别**：技能是刻意打包的可复用操作流程；记忆是在会话中自然积累、经由 Dreaming 持续维护的合作背景与约束。

### 2. Memory Drive：基于 Git 的 Markdown 仓库

- 记忆存放在持久化的 **Git 仓库（Memory Drive）** 中，全部是可读可改的 Markdown 文件。
- **根目录 `MEMORY.md`**：保持简短，存放通用偏好以及指向仓库内其他笔记文件的索引（按仓库、项目或主题组织）。
- **读取方式（常驻索引 + 代码工具按需检索）**：
  - 会话启动时，只把 `MEMORY.md` 作为上下文提供给模型；
  - 其余专题笔记**直接复用导航代码的同一套文件工具（如 `read`、`grep`、`glob`）**按需搜索和读取，不把整个记忆库塞进提示词；
  - 新写下的记忆对**之后的会话**生效，不改动当前正在运行的会话上下文。
- **写入与并发（Per-session Git Checkout + Revision Check）**：
  - 每个会话在自己的 Git checkout 上工作：修改笔记后提交（commit），合并其他会话的更新再保存回 Memory Drive。
  - 若并行会话在此期间已经保存过更新，版本检查（revision check）会拒绝过时的写入，让会话基于新版本重试；真正的冲突才浮出给用户解决，绝不静默覆盖。

### 3. Dreaming：每日单会话后台整理

- 工作时捕获笔记只是第一步，还需要站在跨会话的全局视角回顾。Dreaming 是**每天运行一次的后台异步会话**，对照近期对话与现有记忆库执行四项操作：
  1. **合并重叠笔记（Consolidates overlapping notes）**：例如多个会话分别记下了包管理器和前端框架约定，整合成清晰的专题笔记。
  2. **剔除临时细节（Removes transient details）**：例如删掉“今天下午开发服务器跑在 3001 端口”这类一次性状态。
  3. **清理过时记忆（Removes stale memories）**：删掉已经失效、或没有任何会话使用过的陈旧记录。
  4. **补漏与重整索引（Adds missed lessons & reorganizes `MEMORY.md`）**：补录干活时没来得及记下的有效经验，重整笔记结构与 `MEMORY.md` 索引，同时完整保留来源会话链接与用户明确声明的偏好。

---

## 二、Agent Memory Repo（AMR）规范

出处：[cognition.com/agent-memory-repo](https://cognition.com/agent-memory-repo) 与 [`agentmemoryrepo/agentmemoryrepo`](https://github.com/agentmemoryrepo/agentmemoryrepo)。

- **核心工作流**：检出最新记忆仓库 → 用 `grep` 或顺着 `[[链接]]` 查找当前任务所需的笔记 → 在工作中直接编辑更新条目 → 编辑后提交。
- **目录约定**：
  - 根目录 `MEMORY.md`：包含每个会话都需要的核心上下文，以及指向各主题文件的双链索引（如 `[[projects/optics-sim]]`）。
  - 笔记条目：简明陈述当前事实或规则，可附带元数据（来源会话链接、添加日期）。

---

## 三、Anthropic：The components of agent memory

[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)

- **记忆即预测**：写下一条记忆，本质上是预测这个模式在未来会话中还会用到。
- **对优秀模型而言，“说明目的”更加重要**：
  - 实验表明，给前沿模型（如 Opus 5.5）一个记忆文件夹并说明其用途，模型能自主维护高信噪比的小型笔记并闭环验证；反之，人为规定死板规则（如“只准记失败”）反而会使得分大幅下降。
- **顶层保持精简**：
  - 常驻注入的记忆每轮都消耗 token，且一旦有一条错误就会污染所有会话；顶层 `MEMORY.md` 应控制在 200 行以内仅作核心约定与索引，具体细节下沉到主题文件中按需读取。
- **Dreaming 对照原始记录纠错**：
  - 会话中记录的笔记可能包含未验证的错误假设；后台 Dreaming 通过核对原始对话记录（尤其是反映真实执行结果的 `TOOL RESULT`）可以发现并修正错误笔记，围绕项目核心目标重组结构。
