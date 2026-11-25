# Eevee

Eevee 是基于 [Pi Durable](https://github.com/earendil-works/pi) 构建的主动型智能体：统一 Agent 底座之上，Router 持有只读工具与二叉森林会话记忆负责统筹调度，可复用的 Worker 在后台并发执行并持有附属 Ticket。

> 当前已完成本地 Engine 产品闭环：项目管理、Router/Worker 协作、观察介入、模型与 MCP 管理，以及后台常驻和崩溃恢复。

## 文档

- [设计文档](DESIGN.md) — 愿景、原则与核心概念
- [架构文档](docs/architecture.md) — Monorepo 划分、依赖边界、角色能力矩阵与实施路线

## 开发命令

需要 Node.js 26 或更高版本：

```bash
npm install --ignore-scripts
npm run check          # 依赖检查、架构边界检查、typecheck、lint 与测试
npm run build          # TypeScript Project References 全量增量构建
npm run dev -- info    # 直接从源码运行 CLI
```

## 运行

```bash
eevee start             # 后台启动 Supervisor 与 Engine
eevee status            # 查看进程、地址与重启次数
eevee project create    # 创建项目
eevee stop              # 优雅停止并清理运行状态
```

开发与调试时使用 `eevee start --foreground`，只运行前台 Engine，不启动 Supervisor。Engine 数据默认位于 `~/.eevee`，可通过 `EEVEE_HOME` 覆盖。

## License

[MIT License](./LICENSE)
