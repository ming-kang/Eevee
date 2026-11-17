# 02 角色与能力

## 1. 职责

| 角色 | 职责 | 基础能力 | Opening |
|:-:|---|---|---|
| `router` | 像塔台与运控，负责全局规划、优先级、工单协调、报告处理、验收和长期记忆 | `ticket`、`ask_user`、`read`、`memory`、`handoff`，以及为 Router 启用的扩展 | 记忆 + 项目概况 + 工单一览 + 交接信息 |
| `worker` | 在 Ticket 目标内自主完成工作，管理自己的执行过程，并通过 Report 协同 | `read`、`write`、`edit`、`bash`、`report`，以及为 Worker 启用的扩展 | 记忆 + 工单 + 最新报告 |
| `dreamer` | 内部记忆维护配置，不是独立的产品角色 | `read`、`memory`、`report` 等维护能力 | 记忆 + 待整理记录 |

Ticket 只约束“要完成什么以及如何协同”，不规定 Worker 内部“如何完成”。

Router 是用户的主要入口，但用户同样可以观察和引导 Worker，让 Worker 在该对话中响应。Worker 不独立向用户推送通知，需要自动协调的结果仍通过 Report 交给 Router。

## 2. 角色的组成

一个角色由三部分组成：

- **固定提示词**：描述职责、协同方式与行为原则，不放动态状态。
- **Opening**：在对话创建或重置时生成开场材料，具体组成属于可调整的上下文实现策略。
- **能力配置**：选择该角色需要的 Durable Extension，并按需调整工具和模型。

Extension 可以提供工具、提示词段落、Hook、包装器和后台任务。因此角色能力不是一张工具白名单，也不能只靠过滤工具名实现。

## 3. Extension 的三个层次

1. **安装**：Engine 把 Extension 注册到 Registry。Eevee 原生扩展和为 Durable 重写的用户扩展都使用 Durable Extension API；MCP 服务可以由桥接 Extension 接入。
2. **按角色启用**：Router 与 Worker 分别选择 Extension。Devin Search、DeepWiki 或某个 MCP 扩展可以只给其中一个角色，也可以同时启用。Worker 工单默认共享 Worker 配置，不为每张 Ticket 单独维护插件组合。
3. **向模型呈现**：已启用 Extension 的工具可以直接提供，也可以通过 `deferred + tool_search` 或 `codemode` 按需暴露。`modelTools` 控制模型看到和调用工具的方式，不等于角色是否安装了能力。

角色启用能力用于组织能力与上下文，不是逐次审批或安全权限系统。工具按照本地 YOLO 方式执行，不因为某个 Extension 被启用就增加确认流程。

## 4. 配置原则

- **能力优先于缓存**：同一角色配置尽量保持稳定以复用缓存，但不为了缓存前缀而牺牲需要的能力。
- **默认按角色共享**：不为每张 Ticket 增加一套设置负担；确有单对话调整需求时，再利用 Durable 的 per-conversation 配置。
- **核心能力与普通扩展使用同一机制**：`resources`、`workspace`、`orchestration`、`memory` 与用户扩展都通过 Registry 安装，再由角色选择。
- **角色只声明名称**：应用角色时从 Registry 解析 Extension 和工具，角色定义不持有扩展实例。

角色应用最终映射为 Durable 的 `configure()`：选择 `extensions`，按需收窄 `tools` 或 `modelTools`，并设置 `instructions`、模型和工作目录。具体协同工具与事件流见 [03 工单与调度](03-orchestration.md)。
