## 产品设计与行为契约

| 文档 | 内容 |
|:-:|:-:|
| [00 愿景与原则](design/00-vision.md) | 产品定位、基本设想、YOLO 与取舍原则 |
| [01 概念](design/01-concepts.md) | 核心概念、支撑概念、逻辑数据模型与数据归属 |
| [02 角色与能力](design/02-roles.md) | Router、Worker、内部维护角色与 Extension 能力配置 |
| [03 工单与调度](design/03-orchestration.md) | Router–Worker 协同、报告、投递、主动推进与后台执行 |
| [04 记忆](design/04-memory.md) | 长期记忆边界、Git 记忆库、当前写入方案与可选 Dreaming |
| [05 模型接入与画像](design/05-models.md) | 基于 `pi-ai` 的模型接入、默认模型与模型画像 |
| [06 WebUI](design/06-ui.md) | 低打扰界面、Worker 观察与介入、角色能力配置 |

## 技术架构

| 文档 | 内容 |
|:-:|:-:|
| [00 运行时架构](architecture/00-runtime.md) | 技术定位、进程模型、本地接口、模块划分与数据目录 |
| [01 Pi-Durable 实现映射](architecture/01-durable.md) | 产品概念到 Durable 对话、任务、文档与投递机制的映射 |
| [02 上下文](architecture/02-context.md) | 上下文契约与当前 Opening / reset 实现策略 |

`design/` 描述产品目标与行为契约，`architecture/` 描述跨模块技术方案，`research/` 保存外部资料与源码调研。具体完成情况以 [实现进度](status.md) 为准。

## 备忘

- **隔离数据**：开发和测试时用 `EEVEE_HOME=<临时目录>`，不碰 `~/.eevee/`。
- **Engine 日志**：`eevee start` 启动的 Engine 把输出写到 `<EEVEE_HOME>/runtime/engine.log`；需要实时看日志时用 `npm run engine` 在前台运行。
