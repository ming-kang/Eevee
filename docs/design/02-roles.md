# 角色与能力

## 1. 职责

| 角色 | 职责 | 基础能力 | Opening |
|:-:|---|---|---|
| `router` | 全局规划、工单协调、报告处理、验收与记忆 | `ticket`、`ask_user`、`read`、`memory`、`handoff`，以及为 Router 启用的扩展 | 记忆 + 项目概况 + 工单一览 + 交接信息 |
| `worker` | 在 Ticket 目标内自主完成工作，管理自己的执行过程，并通过 Report 协同 | `read`、`write`、`edit`、`bash`、`report`，以及为 Worker 启用的扩展 | 记忆 + 工单 + 最新报告 |
| `dreamer` | 内部记忆维护配置，不是独立的产品角色 | `read`、`memory`、`report` 等维护能力 | 记忆 + 待整理记录 |

Ticket 只写明做什么（目标、输入、验收标准），怎么做由 Worker 自己决定。

Router 是用户的主要入口，但用户同样可以观察和引导 Worker，让 Worker 在该对话中响应。Worker 不独立向用户推送通知，需要自动协调的结果仍通过 Report 交给 Router。

## 2. 角色的组成

一个角色由三部分组成：

- **固定提示词**：描述职责、协同方式与行为原则，不放动态状态。
- **Opening**：在对话创建或重置时生成开场材料，具体组成属于可调整的上下文实现策略。
- **能力配置**：选择该角色需要的 Durable Extension，并按需调整工具和模型。

Extension 可以提供工具、提示词段落、Hook、包装器和后台任务。因此角色能力不是一张工具白名单，也不能只靠过滤工具名实现。

## 3. Extension 的三个层次

1. **安装**：Engine 把 Extension 注册到 Registry。Eevee 原生扩展和为 Durable 重写的用户扩展都使用 Durable Extension API；MCP 服务可以由桥接 Extension 接入。
2. **按角色启用**：每个角色从已安装的 Extension 中各自选择，同一个 Extension 可以只给一个角色，也可以给多个角色。所有 Worker 共用 `worker` 角色的配置，无需为每张 Ticket 单独配置。
3. **向模型呈现**：已启用 Extension 的工具可以直接提供，也可以通过 `deferred + tool_search` 或 `codemode` 按需暴露。`modelTools` 控制模型看到和调用工具的方式，不等于角色是否安装了能力。

角色启用能力用于组织能力与上下文，不是逐次审批或安全权限系统。工具按照本地 YOLO 方式执行，不因为某个 Extension 被启用就增加确认流程。

## 4. 配置原则

- **能力优先于缓存**：同一角色配置尽量保持稳定以复用缓存，但不为了缓存前缀而牺牲需要的能力。
- **默认按角色共享**：不为每张 Ticket 增加一套设置负担；确有单对话调整需求时，再利用 Durable 的 per-conversation 配置。
- **核心能力与普通扩展使用同一机制**：`resources`、`workspace`、`orchestration`、`memory` 与用户扩展都通过 Registry 安装，再由角色选择。
- **角色只声明名称**：应用角色时从 Registry 解析 Extension 和工具，角色定义不持有扩展实例。

角色应用最终映射为 Durable 的 `configure()`：选择 `extensions`，按需收窄 `tools` 或 `modelTools`，并设置 `instructions`、模型和工作目录。具体协同工具与事件流见 [03 工单与调度](03-orchestration.md)。

## 5. 当前实现

各角色自带的扩展：

| 角色 | 自带扩展 |
|:-:|---|
| `router` | `eevee.resources`、`eevee.dispatch`、`eevee.memory`、`eevee.router` |
| `worker` | `eevee.resources`、`eevee.workspace`、`eevee.report` |
| `dreamer` | `eevee.resources`、`eevee.memory-project`、`eevee.report` |

在此之上，`settings.json` 按角色启用其他扩展、设置每次运行的轮次上限，所有项目共用：

```json
{
  "roles": {
    "router": { "extensions": ["mcp.deepwiki"] },
    "worker": { "extensions": ["mcp.deepwiki", "mcp.github"], "maxTurns": 80 }
  }
}
```

也可以用 `eevee role list / enable / disable / turns`，或 `GET /api/capabilities`、`POST /api/capabilities/roles/:role` 修改；改动立即应用到 Router 和全部未结工单。可启用的扩展、MCP 服务器的连接状态和用户扩展的加载错误都在 `eevee role list`（`GET /api/capabilities`）里。
