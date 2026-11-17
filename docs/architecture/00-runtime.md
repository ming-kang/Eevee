# 00 运行时架构

## 技术定位

Eevee 直接使用 Pi-Durable 构建自己的产品与 Agent 运行时，不嵌入其他 Agent 产品：

```text
Eevee
  · Project / Router / Ticket / Report / Memory
  · Role 能力配置与 Eevee Extensions
  · Engine / CLI / WebUI
  └─ Pi-Durable：持久对话、Agent 循环、任务、文档与观察
       ├─ Pi-AI：模型接入
       └─ Chord：持久状态与基础架构能力
```

Worker 的对话、工具、扩展和任务都由 Eevee 在 Durable 上直接组装。

## 1. 进程模型

参考 [`@astralyn/sash`](https://npmcn.com/package/%40astralyn/sash/) 的轻量守护进程模式，无需 Electron 外壳，直接作为运行在系统 **Node.js >= 26** 上的后台守护进程（`Engine`），通过本地 HTTP 提供 WebUI 与 CLI 控制：

```
┌─────────────── CLI 命令（eevee start / web / status / stop）───────────────┐
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │ 启动守护进程 / 在浏览器打开本地 WebUI
┌─────────────────────────────────────┴──────────────────────────────────────┐
│ 引擎 Engine（常驻后台 Node 26+ 进程，监听 127.0.0.1:<port>）               │
│  · ProjectHost × N：每个项目一个 Harness + SQLite + 记忆仓库               │
│  · 后台任务：持有执行对话、跟踪后台作业、Dreaming 定时器                   │
│  · 对外服务：静态 WebUI + 带类型的 RPC + 实时更新流（转发 Durable watch）  │
└────────────────────────────────────────────────────────────────────────────┘
```

- **原生运行 TypeScript 与 `node:sqlite`**：Node.js 26 直接运行 `.ts` 源码，并原生提供 [Pi-Durable](https://github.com/earendil-works/pi) SQLite 适配器所需的 `DatabaseSync`。
- **关闭页面继续运行**：关闭浏览器标签页不影响后台的作业和 Dreaming；退出由 `eevee stop` 或面板明确触发。
- **一个数据目录一个实例**：启动时先拿 `~/.eevee/` 的实例锁，同一时刻只有一个 Engine 写同一批存储，这也是 Durable“一个存储只能有一个写入进程”的要求。实际监听的端口写进运行时记录，CLI 据此找到正在运行的实例。
- **先恢复再开门**：Engine 启动时先打开全部项目的 Harness，让 Durable 接着跑中断的工作，并把被重启打断的后台作业投给所属执行对话（见 [工单与调度](../design/03-orchestration.md)），然后才开始监听。
- **升级**：通过 npm 安装新版本时旧进程照常运行，装好后重启加载。Durable 的工作都能在重启后接着跑，所以升级不需要等工单做完。

## 2. 本地接口与安全

执行对话能跑任意 `bash` 命令，所以本地接口一旦被别的程序或网页调用，就等于远程执行任意命令。参考 Sash 的做法：

- **只监听回环地址，并校验请求头**：只绑定 `127.0.0.1`，并检查 `Host` 和 `Origin` 都是回环地址，防止 DNS 重绑定和网页跨站请求。
- **所有接口都要鉴权**：只有健康检查对外公开。CLI 使用存放在私有文件里的 token，并且只有 CLI 能调用停止 Engine、生成授权码这类接口；浏览器使用会话 token。两者都放在 `x-eevee-token` 请求头里。
- **实时流**：`/api/stream` 上的 WebSocket 同样只接受回环地址；浏览器无法给 WebSocket 设请求头，所以 token 放在子协议里（`eevee.v1` 加 `token.<token>`），Engine 只回应 `eevee.v1`，token 不会被回显。
- **浏览器授权**：`eevee web` 生成一个 90 秒内有效、只能用一次的授权码，放在打开的 URL 里；页面换到会话后立刻从地址栏移除。会话 12 小时无操作才过期，Engine 只存会话的哈希，重启后已授权的页面可以继续使用。
- **执行环境去敏**：当前实现让 `bash` 和后台作业使用清理过的环境变量，不主动把 Engine 的 API key 注入子进程。这只是减少意外泄漏，不构成对 Worker 的隔离边界。
- **私有文件**：`auth.json`、`settings.json` 等私有文件用原子写入（先写临时文件再改名），POSIX 上的权限为 `0600`。
- **本地 YOLO 模式**：Worker 与 Engine 同属当前用户的本地信任边界，工具不逐次请求授权，也不设置内置沙箱。需要隔离不受信任的工作时，应由用户在 OS、容器或虚拟机层隔离整个运行环境。

## 3. 模块划分

```
contracts ──► orchestration ─┐
          ──► resources ─────┤
          ──► workspace ─────┼──► roles ──► ProjectHost ──► Engine ◄── server ◄── api ──► cli / web
          ──► memory ────────┘                               ▲
          ──► mcp ───────────────────────────────────────────┘
```

| 模块 | 内容 | 详见 |
|:-:|---|:-:|
| `contracts` | 共享定义：领域类型（`Ticket`、`Report`、`Question`）、Durable 文档、资源地址、工单阶段推导。没有 IO | [概念](../design/01-concepts.md) |
| `orchestration` | Durable 扩展：`ticket`、`ask_user`、`report` 工具；持有执行对话的锚点任务；投递表；兜底报告；并发槽位；后台作业的跟踪 | [工单与调度](../design/03-orchestration.md) |
| `resources` | Durable 扩展：统一的 `read` 工具与地址解析、分页、超长输出修剪 | [上下文](02-context.md) |
| `workspace` | Durable 扩展：工作目录里的 `write` / `edit` / `bash`；`bash` 只继承白名单环境变量，超时转为后台作业 | [工单与调度](../design/03-orchestration.md) |
| `memory` | Durable 扩展：`memory` 工具、按轮提交、Dreaming 定时器 | [记忆](../design/04-memory.md) |
| `mcp` | 读取 `mcp.json`，连接 MCP 服务器，把每个服务器桥接成扩展 `mcp.<名字>` | §3.1 |
| `roles` | 定义 `router`、`worker`、`dreamer` 的提示词、Opening 与 Extension 选择，组装各角色能力，并为 `orchestration` 提供端口实现；Router 专用的 `handoff` 也在这里 | [角色与能力](../design/02-roles.md) |
| `ProjectHost` / `Engine` | 每个项目一个 Harness，组装上述模块；Engine 承载全部项目，以及各项目共享的扩展（`tool-search`、`codemode`、MCP、用户扩展） | §1、§3.1 |
| `api` / `server` / `cli` / `web` | 本地接口契约、HTTP 服务与实时流、命令行与 WebUI | §2、[WebUI](../design/06-ui.md) |

另外，**模型接入**不是扩展：在 `@earendil-works/pi-ai` 之上读写 `auth.json`、读取 `models.json`，组装出 Durable 需要的 `Models`（见 [模型接入与画像](../design/05-models.md)）。

### 3.1 扩展的安装与启用

每个项目的 Registry 装两类扩展：

- **Eevee 原生扩展**，由 `ProjectHost` 组装：`eevee.resources`（`read`）、`eevee.workspace`（`write` / `edit` / `bash`）、`eevee.dispatch`（`ticket` / `ask_user`）、`eevee.report`（`report` 与兜底报告）、`eevee.memory`（两个记忆库与 Dreaming 定时器）、`eevee.memory-project`（只能整理项目记忆）、`eevee.router`（`handoff`）。
- **共享扩展**，由 Engine 持有、装进每个项目，变化时重新安装：Durable 的 `tool-search` 与 `codemode`、每个 MCP 服务器一个 `mcp.<名字>`、`~/.eevee/extensions/` 里的用户扩展（默认导出 Durable extension 或返回它的函数；`eevee.*`、`mcp.*` 等名字保留）。

角色的能力 = 角色自带的扩展 + `settings.json` 里 `roles.<角色>.extensions` 启用的扩展。应用角色时按名字从 Registry 解析：选中的工具里有延迟加载（`deferred`）的就带上 `tool-search`，有只给脚本调用的就带上 `codemode`；没安装的名字先跳过并记日志。设置或共享扩展一变，Router 和全部未结工单立刻重新应用角色；Durable 写入不变的配置不会产生记录。

MCP 服务器在 Engine 启动时后台连接，不阻塞开门；没连上的服务器扩展照样存在（没有工具），角色可以照常启用它。`exposure` 决定工具怎样给模型：`deferred`（默认，经 `tool_search` 找到）、`direct`、`codemode`（只给脚本调用，按服务器分组）、`hidden`。stdio 服务器只继承 `bash` 也能拿到的环境变量，`env` / `headers` 可以引用 Engine 的环境变量（`${NAME}`）。

### 工程规则

- **扩展之间不互相 import**，只依赖 `contracts`；跨模块的数据通过 Durable 文档交换。扩展需要的外部能力声明成端口，由 `ProjectHost` 注入。
- **安装与启用分开**：Registry 只表示 Engine 已安装哪些 Extension；每个角色再选择自己需要的 Extension。`roles` 只声明名称，应用角色时从 Registry 解析，不持有扩展实例。
- **能力配置优先于缓存优化**：同一角色尽量共享稳定的能力配置，但不为保持缓存前缀而限制 Router 或 Worker 应获得的能力。
- **每个存储只有一条写入路径**：`session.sqlite` 只由引擎写；记忆仓库只经由 `memory` 模块提交（用户手改的文件在下次提交时单独记一个 commit，见 [记忆](../design/04-memory.md)）。

## 4. 目录结构

```
~/.eevee/
  settings.json          全局配置：角色启用的扩展与轮次上限、模型默认值、Dreaming 间隔、首选端口与并发上限
  runtime/               私有的运行时文件
    engine.lock          实例锁（持有者的 pid）
    engine.json          运行时记录：pid、实际端口、bootId、启动时间
    cli-token            CLI 的 token
    sessions.json        浏览器会话的哈希
    engine.log           eevee start 启动时的日志
    mcp-output/          MCP 工具输出被截断时的完整内容
  auth.json              凭据
  models.json            自定义 provider、模型和覆盖
  models.md              模型画像：用户写的使用经验
  mcp.json               MCP 服务器（mcpServers 格式，另加 exposure）
  extensions/            用户扩展：*.ts / *.js / *.mjs
  memory/                全局记忆库（Git）
    MEMORY.md            只有这一个文件，保持极短
  projects/<projectId>/
    project.json         标题、关联的工作目录、创建时间
    session.sqlite       Durable 存储：全部对话记录与工单、报告、问题文档
    memory/              项目记忆库（Git）
      MEMORY.md          常驻索引
      <topic>.md         按需读取的主题笔记
    jobs/<jobId>.log     后台作业的完整输出
```
