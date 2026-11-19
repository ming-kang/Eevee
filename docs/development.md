# 参与开发

## 准备环境

需要 Node.js 26 或更高版本和 Git。在源码目录里安装依赖：

```bash
npm install
```

Node.js 26 直接运行 `.ts` 源码，开发时不需要先编译。

## 常用脚本

| 命令 | 作用 |
|:-:|:-:|
| `npm run dev -- <args>` | 直接从源码运行命令行，如 `npm run dev -- status` |
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

在另一个终端里用同一个 `EEVEE_HOME` 运行命令行，打开面板：

```bash
EEVEE_HOME=<同一目录> npm run dev -- web
```

## 面板开发

面板的设计目标见 [用户界面](design/06-ui.md)。

`npm run dev:scenario` 用 faux 模型启动一个 Engine，并预先造好几个项目，覆盖待回答的问题、执行中、后台作业、受阻、失败、Router 失败和角色启用了已卸载的扩展等状态。没有设置 `EEVEE_HOME` 时它使用临时目录，退出时删除；`EEVEE_PORT` 可以指定端口。启动后终端里打印两个带一次性授权码的地址，分别用于内置界面和 Vite 开发服务器：

```bash
EEVEE_PORT=19391 npm run dev:scenario
EEVEE_ENGINE=http://127.0.0.1:19391 npm run web:dev
```

造完数据后，模型每次回答前停顿 5 秒，方便在面板里观察运行中的状态，试用引导、排队和打断。`npm run dev:scenario -- --check` 只造数据并自检，然后退出。

路由、工单分组、项目状态位、对话条目映射、流客户端、provider 与 MCP 表单和配置条目之间的转换等纯逻辑都放在 `web/src/` 下独立的 `.ts` 里，用 `node --test` 离线测试；组件只负责渲染。

### 面板样式

样式是全局类，按区域拆在 `web/src/styles/` 下，由 `web/src/style.css` 依次引入。组件不写 scoped 样式，颜色只用语义 token；表面分层、主题和字号换算的规则写在 `tokens.css` 开头的注释里。需要直接操作 DOM 的行为集中在 `web/src/dom.ts`，其中可判断的规则抽在 `web/src/dom-rules.ts`，可以离线测试。

### 消息 Markdown

回答由 [stream-markdown-parser](https://github.com/Simon-He95/markstream-vue/tree/main/packages/markdown-parser) 解析。`web/src/markdown.ts` 把它的节点收窄成面板支持的几种块和行内元素，认不出的节点退化为文字，模型写的 HTML 因此不会生效。正在输出的消息增量解析，未闭合的语法先按闭合显示，输出结束后再做一次完整解析；渲染由 `MarkdownText`、`MarkdownBlocks` 和 `MarkdownInlines` 完成。

### 面板文字

面板有英文和简体中文两种语言，**英文是源语言，也是键**：界面文字写成英文并包进 `t()`，中文翻译在 `web/src/locales/zh-CN.ts`，缺翻译时退回英文。参数插值、`{n} job|{n} jobs` 单复数、`::名字` 后缀消歧和语言选择的写法都写在 `web/src/i18n.ts` 的注释里。

Engine 给面板的只有数据：通知、工具结果、失败原因、错误码（见 [实时流](stream.md) 与 [HTTP 接口](http-api.md#错误)）。面板按数据用读者的语言措辞（`web/src/errors.ts`），不解析 Engine 写给模型的文字；只有别人的原话原样显示。

新的错误加进 `src/contracts/problem.ts`：请求被拒加到 `Problem`，并在 `src/server/http.ts` 的 `STATUS` 里给它一个状态码；配置问题加到 `ConfigIssue`。Engine 的英文措辞写在两个 `describe…`，面板的措辞写在 `errors.ts`，漏写一处类型检查就不通过。

`web/src/i18n.test.ts` 扫描全部组件：`t()` 之外出现中文、用到的键没有中文、中文表里有没人用的键，都会失败。

## 测试

测试用 Node 自带的 `node:test`，与源码放在一起，命名为 `*.test.ts`；运行单个文件用 `node --test src/<path>.test.ts`。

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
| `src/contracts/` | 共享定义：领域类型（工单、报告、问题）、持久状态、资源地址、工单阶段推导、`models.json` 的格式。没有 IO |
| `src/extensions/orchestration/` | `ticket`、`ask_user`、`report` 工具；投递表；兜底报告；并发槽位；后台作业的跟踪 |
| `src/extensions/resources/` | 统一的 `read` 工具、地址解析和分页 |
| `src/extensions/workspace/` | 工作目录里的 `write`、`edit`、`bash`；长命令转为后台作业 |
| `src/extensions/memory/` | `memory` 工具、按轮提交、Dreaming 定时器 |
| `src/extensions/mcp/` | 读写 `mcp.json`、连接 MCP 服务器、把工具桥接为扩展 |
| `src/roles/` | `router`、`worker`、`dreamer` 的提示词、开篇和扩展选择；Router 的 `handoff` |
| `src/models/` | 在 pi-ai 之上读写 `auth.json` 和 `models.json`、向端点请求模型列表、查内置参考模型目录 |
| `src/engine/` | `ProjectHost`（一个项目的存储与运行）、`Engine`（全部项目和共享扩展）、后台作业表、视图 |
| `src/api/` | 本地接口的类型契约、HTTP 客户端、实时流协议 |
| `src/server/` | HTTP 服务、鉴权（token 与一次性授权码）、实时流 |
| `src/cli/` | 命令行：`program.ts` 定义命令，`index.ts` 实现启动、停止和打开面板 |
| `src/shared/` | 路径、设置、配置读取、文件写入等公共工具 |
| `web/` | 面板（Vue） |

## 工程规则

- **扩展之间不互相 import**，只依赖 `contracts`。跨模块的数据经 `contracts` 里定义的持久状态交换；扩展需要的外部能力声明成端口，由 `ProjectHost` 注入。
- **安装与启用分开**：项目安装了哪些扩展，和每个角色选用哪些扩展是两回事。`roles` 只声明名字，应用角色时按名字解析，不持有扩展实例。
- **状态写进存储**：任何重置后还需要的信息（工单、依赖、待回答的问题）都必须是持久状态，不能只留在模型的上下文里。
- **每个存储只有一条写入路径**：`session.sqlite` 只由 Engine 写；记忆库只经由 `memory` 模块提交；`settings.json`、`auth.json`、`models.json`、`mcp.json` 各有一个串行的写入者。
- **事务里按 key 读文档**：工单和问题只在创建时传入完整的值作为 seed，其余事务一律用 `tx.doc(TicketDoc, id, null)` 查找，不拿事务外读到的快照当 seed；要依据的状态都在提交的事务里读。
- **后台工作有主人**：Engine 里由定时器或提交触发的异步工作用 `src/shared/serial-pass.ts` 的 `SerialPass` 调度，关闭时先等它们结束，再关闭它们用到的作业和 Session。
- **能力优先于缓存**：同一角色尽量保持稳定的配置以复用缓存，但不为了缓存前缀限制角色需要的能力。
- **代码用英文写**：源码、注释、测试名称、CLI 输出、日志和给模型看的文字一律英文。例外只有 `web/src/locales/zh-CN.ts` 的翻译值、`LOCALE_NAME` 里语言自己的名字，以及匹配这些中文的测试断言和正则；文档是中文的用户文档，不在此列。这条规则由 `src/shared/language.test.ts` 看守。
- **只用可擦除的 TypeScript 语法**（`erasableSyntaxOnly`）：不用 `enum`、`namespace` 和构造器参数属性。代码须在 Windows 和 POSIX 上都能运行，注意路径、shell 与进程的差异。
- **依赖锁定精确版本**：所有 `@earendil-works/*` 包共享一个版本、一起升级；按 `node_modules` 里安装的类型写代码，不 vendor、不凭空猜测 API。

## 文档

| 位置 | 内容 |
|---|---|
| `docs/*.md` | 使用文档，导航见 `docs/docs.json`，新页面要登记进去 |
| `docs/design/` | 产品目标与行为契约 |
| `docs/research/` | 外部资料与源码调研 |

文档只描述已实现的行为，以 `src/` 为准；用户可见的行为变化要同步更新。不重复 Pi Durable 的内部机制，链接它的文档即可。`CHANGELOG.md` 的 `## [Unreleased]` 只记相对上一个已发布版本的用户可见变化：改动尚未发布的功能时，修改它原有的条目，不另加一条；首个版本发布前这一节为空。
