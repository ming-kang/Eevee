# 参与开发

这一页面向 Eevee 开发者：搭建环境、运行检查、隔离数据与代码规范。

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
| `npm run dev:scenario` | 启动一个带模拟数据的 Engine，供面板开发使用，见下文 |
| `npm run build` | 编译到 `dist/`，并构建面板 |
| `npm run typecheck` | 检查后端和面板的类型 |
| `npm run lint` / `npm run lint:fix` | 用 Biome 检查代码风格 / 自动修复 |
| `npm test` | 运行全部测试 |
| `npm run check` | 依次运行类型检查、代码风格检查和测试，提交前运行 |

## 隔离数据

开发和测试时设置 `EEVEE_HOME`，避免影响 `~/.eevee/`：

```bash
export EEVEE_HOME="$(mktemp -d)"
npm run engine
```

在另一个终端里用同一个 `EEVEE_HOME` 运行命令行：

```bash
EEVEE_HOME=<同一个目录> npm run dev -- project create 测试 --workspace /tmp/eevee-ws
```

同一个数据目录同时只能运行一个 Engine。

## 面板开发

`npm run dev:scenario` 用 faux 模型启动一个 Engine，并预先造好几个项目，覆盖待回答的问题、执行中、后台作业、受阻、失败和 Router 失败等状态，不需要凭据，也不调用付费模型。没有设置 `EEVEE_HOME` 时它使用临时目录，退出时删除；`EEVEE_PORT` 可以指定端口。启动后终端里打印两个带授权码的地址，分别用于内置界面和 Vite 开发服务器：

```bash
EEVEE_PORT=19391 npm run dev:scenario
EEVEE_ENGINE=http://127.0.0.1:19391 npm run web:dev
```

造完数据后，每次回答前模型会停顿 5 秒，可以在面板里看到运行中的状态，试用引导、排队和打断。授权码只能用一次。`npm run dev:scenario -- --check` 只造数据并自检，然后退出。

### 面板样式

样式是全局类，按区域拆在 `web/src/styles/` 里，由 `web/src/style.css` 依次引入：

| 文件 | 内容 |
|---|---|
| `tokens.css` | 两个主题的全部语义 token：表面层级、文字层级、颜色、阴影、圆角、控件高度、动效时长；字号与图标尺寸都由 `--ev-ui` 按比例换算（`theme.ts` 的 `useTextSize` 设置它） |
| `base.css` | 重置、焦点环、图标尺寸、关键帧、`prefers-reduced-motion` |
| `controls.css` | 按钮、输入框、开关、分段控件、状态图形、卡片和列表行 |
| `shell.css` | 左栏、主区域、右栏和三种宽度下的布局 |
| `conversation.css` | 对话、过程行、diff、输入框、提问卡片 |
| `rail.css` | 右栏的工单、作业、详情 |
| `overlays.css` | 对话框、命令面板、浮层、悬停卡片、提示、连接页 |
| `pages.css` | 设置、记忆、花费 |

组件不写 scoped 样式，行内样式只用于运行时算出的位置和宽度，颜色只用 `tokens.css` 里的语义 token；层级和尺寸规则见 [WebUI 思路](design/06-ui.md#视觉与动效)。面板直接操作 DOM 的行为都在 `web/src/dom.ts`，其中的判断放在 `web/src/dom-rules.ts`，可以离线测试：

- 分段控件写成 `<div v-seg class="seg">`，选中的按钮（`.on`、`aria-selected` 或 `aria-pressed`）下面有一块随选择滑动的底板；
- 会持续增长的输出（作业日志、命令输出）加 `v-tail`，打开时停在最新一行并跟随新输出，读者往上翻时暂停；
- `trackFocusModality()` 在 `<html>` 上标出 `data-modality`，用鼠标时焦点环宽度为 0，用 Tab 或方向键时才画。新写的焦点样式用 `--ev-ring` / `--ev-ring-in`，文本框用 `--ev-ring-field`。

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
