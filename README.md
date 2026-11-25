# Eevee

Eevee 是基于 [Pi Durable](https://github.com/earendil-works/pi) 构建的主动型智能体：统一 Agent 底座之上，Router 持有只读工具与二叉森林会话记忆负责统筹调度，可复用的 Worker 在后台并发执行并持有附属 Ticket。

> 重构期：当前已完成多包仓库框架搭建，核心子系统按阶段实现中。

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

## License

[MIT License](./LICENSE)
