# 配置

Eevee 的全部配置和数据都在一个数据目录里，默认是 `~/.eevee/`，用环境变量 [`EEVEE_HOME`](environment-variables.md) 可以换一个位置。下文都写作 `~/.eevee/`。

常用的设置可以在面板的“设置”里修改，改动立即生效；其他配置可以直接编辑对应文件。

## 数据目录

| 路径 | 作用 |
|---|---|
| `settings.json` | 全局[设置](settings.md)：端口、并发上限、各角色的默认模型和启用的扩展、Dreaming 间隔等 |
| `auth.json` | 在面板里填写的 API Key |
| `models.json` | 自定义 provider、模型和模型覆盖，见 [模型配置](models-configuration.md) |
| `models.md` | 你记录的模型使用经验，见 [选择模型](models.md#记录模型的使用经验) |
| `mcp.json` | [MCP 服务器](mcp.md) |
| `extensions/` | [用户扩展](extensions.md)：`*.ts`、`*.js`、`*.mjs` 文件 |
| `memory/` | 全局记忆库（Git），只有一个 `MEMORY.md` |
| `projects/<project>/` | 一个项目的全部数据，见下表 |
| `runtime/` | Engine 运行时的私有文件，见下表 |

## 项目目录

| 路径 | 作用 |
|---|---|
| `project.json` | 标题、关联的工作目录、创建时间，以及可选的项目默认模型 |
| `session.sqlite` | 项目的持久存储：全部对话记录，以及工单、报告、问题 |
| `memory/` | 项目记忆库（Git）：`MEMORY.md` 和主题笔记 |
| `jobs/<job>.log` | 后台作业的完整输出 |

工作目录本身是你自己的目录，不在数据目录里。

## 运行时目录

| 路径 | 作用 |
|---|---|
| `engine.lock` | 实例锁，保证同一个数据目录只有一个 Engine |
| `engine.json` | 正在运行的 Engine 的 pid、实际端口、`bootId` 和启动时间 |
| `token` | 调用本地接口鉴权 token，详见 [鉴权](integration.md#鉴权) |
| `engine.log` | `eevee start` 启动的 Engine 的输出 |
| `mcp-output/` | MCP 工具输出被截断时保存的完整内容 |

`runtime/` 里的文件都是私有的，不要复制到别处或分享。

## 修改后什么时候生效

| 修改 | 生效时机 |
|---|---|
| 在面板里修改默认模型或角色能力 | 立即应用到全部项目的 Router 和未结工单 |
| 手动编辑 `settings.json` | 重启 Engine 后，或下一次在面板里修改设置时；`port` 只在 Engine 启动时读取 |
| 在面板里保存 API Key 或 provider | 立即 |
| 手动编辑 `models.json` | 下次在面板里保存 API Key 或 provider，或重启 Engine 后 |
| 编辑 `models.md` | 下次读取时（`read models://`、面板的“设置 · 模型”） |
| 在面板里保存 MCP 服务器 | 立即，只重连这一个服务器 |
| 手动编辑 `mcp.json` | 在“设置 · MCP 与扩展”里点“重新加载”后 |
| 增删改 `extensions/` 里的文件 | 重启 Engine 后 |
| 编辑 `project.json` | 重启 Engine 后 |
| 编辑记忆文件 | 之后创建或重置的对话 |

重启 Engine 就是 `eevee stop` 再 `eevee start`，进行中的工作会接着进行。

## 配置文件的校验

`settings.json` 和 `models.json` 读取时按结构校验：

- `settings.json` 字段不对时 Engine 无法启动，错误信息会指出文件和字段；在面板里修改设置时，写入前同样会校验。
- `models.json` 字段类型或结构写错时整个文件都不生效，日志里给出字段路径；结构正确但组不成 provider（比如缺 `baseUrl`、`api` 不认识）时，只影响那一个 provider。
- `mcp.json` 里配错的服务器会被跳过，其他服务器照常连接，问题显示在“设置 · MCP 与扩展”里。

这几个文件和项目的 `project.json` 如果根本不是合法 JSON，Engine 无法启动，日志里的语法错误不带文件名。

`settings.json` 可以加一个 `$comment` 字段写备注，Eevee 会忽略它。
