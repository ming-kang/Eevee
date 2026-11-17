# 参与开发

这一页面向修改 Eevee 本身的开发者：怎样搭建环境、运行检查、隔离数据，以及代码按什么规则组织。

## 准备环境

需要 Node.js 26 或更高版本和 Git。在源码目录里安装依赖：

```bash
npm install
```

Node.js 26 直接运行 `.ts` 源码，开发时不需要先编译。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev -- <参数>` | 直接从源码运行命令行，如 `npm run dev -- status` |
| `npm run engine` | 在前台运行 Engine，日志直接输出到终端 |
| `npm run web:dev` | 启动面板的 Vite 开发服务器 |
| `npm run build` | 编译到 `dist/`，并构建面板 |
| `npm run typecheck` | 检查后端和面板的类型 |
| `npm run lint` / `npm run lint:fix` | 用 Biome 检查代码风格 / 自动修复 |
| `npm test` | 运行全部测试 |
| `npm run check` | 依次运行类型检查、代码风格检查和测试，提交前运行 |

## 隔离数据

开发和测试时设置 `EEVEE_HOME`，不要碰你日常使用的 `~/.eevee/`：

```bash
export EEVEE_HOME="$(mktemp -d)"
npm run engine
```

在另一个终端里用同一个 `EEVEE_HOME` 运行命令行：

```bash
EEVEE_HOME=<同一个目录> npm run dev -- project create 测试 --workspace /tmp/eevee-ws
```

同一个数据目录同时只能运行一个 Engine。

## 测试

测试用 Node 自带的 `node:test`，与源码放在一起，命名为 `*.test.ts`。

端到端测试不调用真实模型：`src/engine/testing.ts` 用 pi-ai 的 faux provider 搭起一个完整的项目，测试按角色写出模型每一轮的回答和工具调用，再检查工单、报告、投递和记忆的结果。MCP 相关测试用 `src/extensions/mcp/testing.ts` 里的内存 MCP 服务器。

新功能应当配一个说明行为的测试；修复问题时先写一个能复现它的测试。

## 代码结构

```
contracts ──► orchestration ─┐
          ──► resources ─────┤
          ──► workspace ─────┼──► roles ──► ProjectHost ──► Engine ◄── server ◄── api ──► cli / web
          ──► memory ────────┘                               ▲
          ──► mcp ───────────────────────────────────────────┘
```

| 目录 | 内容 |
|---|---|
| `src/contracts/` | 共享定义：领域类型（工单、报告、问题）、持久状态、资源地址、工单阶段推导。没有 IO |
| `src/extensions/orchestration/` | `ticket`、`ask_user`、`report` 工具；投递表；兜底报告；并发槽位；后台作业的跟踪 |
| `src/extensions/resources/` | 统一的 `read` 工具、地址解析和分页 |
| `src/extensions/workspace/` | 工作目录里的 `write`、`edit`、`bash`；长命令转为后台作业 |
| `src/extensions/memory/` | `memory` 工具、按轮提交、Dreaming 定时器 |
| `src/extensions/mcp/` | 读取 `mcp.json`、连接 MCP 服务器、把工具桥接为扩展 |
| `src/roles/` | `router`、`worker`、`dreamer` 的提示词、开篇和扩展选择；Router 的 `handoff` |
| `src/models/` | 在 pi-ai 之上读写 `auth.json`、读取 `models.json`、生成 `models://` 目录 |
| `src/engine/` | `ProjectHost`（一个项目的存储与运行）、`Engine`（全部项目和共享扩展）、后台作业表、视图 |
| `src/api/` | 本地接口的类型契约、HTTP 客户端、实时流协议 |
| `src/server/` | HTTP 服务、鉴权、实时流 |
| `src/cli/` | 命令行，按命令组拆分 |
| `src/shared/` | 路径、设置、配置读取、文件写入等公共工具 |
| `web/` | 面板（Vue） |

## 工程规则

- **扩展之间不互相 import**，只依赖 `contracts`。跨模块的数据经 `contracts` 里定义的持久状态交换；扩展需要的外部能力声明成端口，由 `ProjectHost` 注入。
- **安装与启用分开**：项目安装了哪些扩展，和每个角色选用哪些扩展是两回事。`roles` 只声明名字，应用角色时按名字解析，不持有扩展实例。
- **状态写进存储**：任何重置后还需要的信息（工单、依赖、待回答的问题）都必须是持久状态，模型的上下文只是它的一个视图。
- **每个存储只有一条写入路径**：`session.sqlite` 只由 Engine 写；记忆库只经由 `memory` 模块提交；`settings.json`、`auth.json` 各有一个串行的写入者。
- **能力优先于缓存**：同一角色尽量保持稳定的配置以复用缓存，但不为了缓存前缀限制角色需要的能力。
- **依赖的 Pi 包锁定版本**：按 `node_modules` 里安装的类型编写代码。

## 文档

| 位置 | 内容 |
|---|---|
| `docs/*.md` | 使用文档，导航见 `docs/docs.json` |
| `docs/design/` | 产品目标与行为契约 |
| `docs/research/` | 外部资料与源码调研 |

用户可见的行为变化要同步更新使用文档，并记进 `CHANGELOG.md`。
