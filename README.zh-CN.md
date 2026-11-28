# Eevee

[English](README.md) | **简体中文**

一个主动型智能体：把长耗时工作交给后台 Worker 执行，你可以随时观察和引导它们，Eevee 只在必要时打扰你。

你只需与一个 Router 对话，它负责规划工作，并以 Ticket 的形式交给在后台并发运行、可复用的 Worker。你可以随时打开任意 Worker，查看完整对话与任务日志、发送引导或中止它。Eevee 基于 [Pi Durable](https://github.com/earendil-works/pi) 构建。

> **状态：** 早期开发阶段（v0.0.1）。本地 Engine、CLI 与 Web UI 已经完整可用，但 API 与数据格式仍可能变化。

## 特性

- **Router 与 Worker**：只读的 Router 负责统筹调度，可复用的 Worker 在后台并发执行，并在多个 Ticket 之间保持热上下文。
- **可观测、可介入**：实时查看、引导或中止任意 Worker 与后台任务。
- **长期记忆**：静默运行的 Dreamer 将 Router 会话整理为可逐层展开的二叉森林。
- **项目**：每个项目可绑定多个工作目录，拥有独立的项目记忆与持久会话库。
- **模型与 MCP**：通过 CLI 或 Web UI 管理模型提供方、模型、MCP 服务器与技能。
- **本地常驻**：由 Supervisor 托管的后台 Engine，支持崩溃恢复，并提供同源浏览器工作台。

## 快速开始

需要 Node.js 26 或更高版本。

```bash
git clone https://github.com/ming-kang/Eevee.git
cd Eevee
npm install --ignore-scripts
npm run build
cd apps/cli && npm link     # 将 `eevee` 命令加入 PATH
```

然后启动 Engine 并打开 Web UI：

```bash
eevee start             # 后台启动 Supervisor 与 Engine
eevee web --open        # 签发一次性免密链接并打开 Web UI
eevee status            # 查看进程、地址与重启次数
eevee project create    # 创建项目
eevee stop              # 优雅停止并清理运行状态
```

开发与调试时使用 `eevee start --foreground`，只运行前台 Engine，不启动 Supervisor。Engine 数据默认位于 `~/.eevee`，可通过 `EEVEE_HOME` 覆盖。

## 开发

```bash
npm run check          # 依赖检查、架构边界检查、typecheck、lint 与测试
npm run build          # TypeScript Project References 与 Web UI 全量构建
npm run dev -- info    # 直接从源码运行 CLI
npm run dev:web        # 启动 Web UI Vite 开发服务器（代理至本机 Engine）
```

## 文档

- [设计文档](DESIGN.md)：愿景、原则与核心概念
- [架构文档](docs/architecture.md)：包划分、依赖边界、角色扩展装配与构建方式

## License

[MIT](LICENSE)
