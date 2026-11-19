# 角色与能力

## 1. 职责

| 角色 | 职责 | 基础能力 | Opening |
|:-:|---|---|---|
| `router` | 全局规划、工单协调、报告处理、验收与记忆 | `ticket`、`ask_user`、`read`、`memory`、`handoff`，以及为 Router 启用的扩展 | 记忆 + 项目概况 + 工单一览 + 交接信息 |
| `worker` | 在 Ticket 目标内自主完成工作，管理自己的执行过程，并通过 Report 协同 | `read`、`write`、`edit`、`bash`、`report`，以及为 Worker 启用的扩展 | 记忆 + 工单 + 最新报告 |
| `dreamer` | 内部记忆维护配置，不构成独立的产品角色 | `read`、`memory`、`report` 等维护能力 | 记忆 + 待整理记录 |

Ticket 只写明做什么（目标、输入、验收标准），怎么做由 Worker 自己决定。

Router 是用户的主要入口，但用户同样可以观察和引导 Worker，让 Worker 在该对话中响应。Worker 不独立向用户推送通知，需要自动协调的结果仍通过 Report 交给 Router。

## 2. 角色的组成

一个角色由三部分组成：

- **固定提示词**：描述职责、协同方式与行为原则，不放动态状态。
- **Opening**：在对话创建或重置时生成开场材料，具体组成属于可调整的上下文实现策略。
- **能力配置**：选择该角色需要的 Durable Extension，并按需调整工具和模型。

Extension 可以提供工具、提示词段落、Hook、包装器和后台任务。因此角色能力不是一张工具白名单，也不能只靠过滤工具名实现。

## 3. Extension

1. **安装**：Engine 把 Extension 注册到 Registry。扩展使用Durable Extension API，MCP 服务可以由桥接 Extension 接入。
2. **按角色启用**：已安装的 Extension 可为每种角色分别配置启用与否。
3. **向模型呈现**：已启用 Extension 的工具可以直接提供，也可以通过 `deferred + tool_search` 或 `codemode` 按需暴露；`modelTools` 控制模型看到和调用工具的方式。

## 4. 配置原则

- **能力优先于缓存**：同一角色配置尽量保持稳定以复用缓存，但不为了缓存前缀而牺牲需要的能力。
- **统一机制**：`resources`、`workspace`、`orchestration`、`memory` 与用户扩展都通过 Registry 安装，再由角色选择。
- **角色只声明名称**：应用角色时从 Registry 解析 Extension 和工具，角色定义不持有扩展实例。

角色应用最终映射为 Durable 的 `configure()`：选择 `extensions`，按需收窄 `tools` 或 `modelTools`，并设置 `instructions`、模型和工作目录。具体协同工具与事件流见 [03 工单与调度](03-orchestration.md)。

## 5. 角色配置

角色配置所有项目共用，可以在面板或配置文件里调整，修改对之后的运行生效：

- **按角色启用扩展**：在角色自带能力之上，为每种角色选择额外的 Extension（如 MCP 服务）。
- **运行上限**：限制一次运行的轮次，避免执行对话无止境地运行。
- **容错**：已启用但后来卸载的扩展在应用时跳过，不影响角色的其他能力。
