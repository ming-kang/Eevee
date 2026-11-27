# 架构

本文档记录仓库的包划分、依赖边界与构建机制；愿景与核心概念见 [DESIGN.md](../DESIGN.md)。

## 包划分与依赖

```text
@eevee/agent ──▶ @eevee/core ──▶ @eevee/engine ──▶ @eevee/cli
                     ▲                 │
@eevee/memory ───────┘                 ▼
                               @eevee/protocol ───▶ @eevee/cli
                                       │
                                       └──────────▶ @eevee/web
```

| 包 | 路径 | 职责 | 内部依赖 |
|:-:|:-:|---|:-:|
| `@eevee/agent` | `packages/agent` | 基于 `pi-durable` 的 Agent 底座：模型/凭据、上下文发现与内置扩展 | 无 |
| `@eevee/memory` | `packages/memory` | 会话级二叉森林记忆与 Dreamer | 无 |
| `@eevee/core` | `packages/core` | 存储无关的编排逻辑：Project、Router、Worker、Ticket、Question | `agent`, `memory` |
| `@eevee/protocol` | `packages/protocol` | 运行时无关的 HTTP/SSE Schema 与契约（基于 `pi-schema`） | 无 |
| `@eevee/engine` | `packages/engine` | 本地 Engine 与 Supervisor：`engine.sqlite`、多项目托管、共享与项目级 MCP Hub（含 MCP OAuth）、HTTP/SSE、Web 鉴权与静态托管、崩溃重启与优雅退出 | `agent`, `memory`, `core`, `protocol` |
| `@eevee/cli` | `apps/cli` | 命令行客户端 | `protocol`, `engine` |
| `@eevee/web` | `apps/web` | 浏览器端工作台，构建后由 Engine 同源托管 | `protocol` |

### `@eevee/agent` 内部模块

- `models/`：管理 `auth.json`、`models.json`、`models-store.json` 与 `ModelRuntime`。
- `context/`：`AGENTS.md` / `SKILL.md` 发现与基础提示词段落。
- `extensions/`：独立 `pi-durable` 扩展，`coding-tools`（提供 `readonly-tools` 与 `coding-tools`）、`shell-paths`、`tasks`、`codemode`、`tool-search`、`mcp`、`cached-compaction`。

## 硬性边界

由 `scripts/check-deps.ts` 与 `scripts/check-boundaries.ts` 在 `npm run check` 时静态检查：

- **依赖单向**：源码与 `package.json` 必须遵守上表依赖关系，禁止跨包相对路径导入。
- **扩展隔离**：`packages/agent/src/extensions/<name>/` 下的扩展禁止互相 import。
- **运行时纯净**：`@eevee/core` 与 `@eevee/memory` 禁止引入 `node:sqlite` / `node:http` / `ws`；`@eevee/protocol` 与 `@eevee/web` 禁止引入 Node 专属运行时模块。
- **上游约定**：禁止引入 `@earendil-works/chord` 根 host runtime（仅使用 `/context`、`/watch`、`/json`）；生产代码禁止通过 `child_process` 调用 `git`。

## 角色扩展装配

Router 与 Worker 共享同一 Agent 底座，差异体现在挂载的扩展：

| 扩展 | Router | Worker |
|:-:|:---:|:---:|
| `eevee.readonly-tools`（`read` / `ls` / `find` / `grep`） | ✓ | — |
| `eevee.coding-tools`（`read` / `write` / `edit` / `bash`，可选 `powershell`；工具支持全局与项目级开关） | — | ✓ |
| `eevee.shell-paths` / `codemode` / `tool-search` / `mcp` | ✓ | ✓ |
| `eevee.tasks`（显式后台 + 超时转后台） | — | ✓ |
| `eevee.cached-compaction` | — | ✓ |
| `eevee.memory`（二叉森林记忆） | ✓ | — |
| 编排扩展 | `eevee.router` | `eevee.worker` |

## 源码运行与构建

- **开发与测试**：内部包通过自定义导出条件 `"eevee-source"` 指向 `./src/*.ts`（避免与 `@earendil-works/*` 发布包内的 `"source"` 字段冲突），`node --conditions=eevee-source` 直接执行 TypeScript 源码，无需预编译。
- **类型检查**：根 `tsconfig.json` 通过 `paths` 映射源码，`npm run typecheck` 同时校验主工程与 `apps/web/tsconfig.json`。
- **增量构建**：`npm run build` 运行 `tsc -b tsconfig.build.json` 并构建 `@eevee/web` 静态产物（`apps/web/dist`），供 Engine 在 `127.0.0.1` 同源托管。
