# 命令行

命令行只负责运行 Engine 和打开面板；项目、模型、角色能力、MCP 和记忆都在 [面板](web.md) 里管理，脚本可以直接调用 [本地接口](integration.md)。命令行的描述和输出都是英文，运行 `eevee --help` 可以查看你安装的版本的确切用法。

```sh
eevee
eevee start | stop | status | web
```

| 命令 | 作用 |
|---|---|
| `eevee` | 等价于 `eevee start` 再 `eevee web`：没有运行时先在后台启动 Engine，然后在浏览器里打开面板。不带命令时的描述是 `A proactive agent. With no command it starts the Engine and opens the panel` |
| `eevee start` | `Start the Engine in the background`。在后台启动 Engine，等它开始接受请求后打印 `Started: <地址>/ui/`。已经在运行时只打印 `Already running: <地址>/ui/`。15 秒内没启动成功会报错 `Timed out starting; see the log: <日志路径>` |
| `eevee stop` | `Stop the Engine`。停止 Engine 并打印 `Stopped.` |
| `eevee status` | `Show the run status and the projects`。打印 `Eevee <版本> · <地址>/ui/ · pid <pid>`，下面每行一个项目的编号、标题和工作目录 |
| `eevee web` | `Open and authorize the panel in a browser`。生成一次性授权码，在浏览器里打开面板，并打印 `Opened in the browser (the authorization code is valid for 90 seconds): <地址>`。授权码 90 秒内有效 |

| 选项 | 作用 |
|---|---|
| `-V`, `--version` | 输出版本号 |
| `-h`, `--help` | 输出帮助 |

`eevee web` 需要 Engine 在运行，没有运行时抛出 `Eevee is not running: run eevee to start it and open the panel.`；Engine 没运行时，`stop` 和 `status` 只输出 `Not running.`。不认识的命令报 `No command <命令>; see eevee --help`，不会当成不带命令。命令出错时把错误信息写到 stderr，退出码为 1。

命令行按 [`EEVEE_HOME`](environment-variables.md) 找到数据目录，再从 `runtime/engine.json` 读取 Engine 的端口、从 `runtime/token` 读取 token。

`eevee start` 启动的 Engine 把输出追加到 `runtime/engine.log`，并把当前的 `EEVEE_HOME` 和环境变量传给它。
