# 命令行

命令行只负责运行 Engine 和打开面板；项目、模型、角色能力、MCP 和记忆都在 [面板](web.md) 里管理，脚本可以直接调用 [本地接口](integration.md)。运行 `eevee --help` 可以查看你安装的版本的确切用法。

```sh
eevee
eevee start | stop | status | web
```

| 命令 | 作用 |
|---|---|
| `eevee` | 等价于 `eevee start` 再 `eevee web`：没有运行时先在后台启动 Engine，然后在浏览器里打开面板 |
| `eevee start` | 在后台启动 Engine，等它开始接受请求后打印地址。已经在运行时只打印地址。15 秒内没启动成功会报错，并给出日志位置 |
| `eevee stop` | 停止 Engine |
| `eevee status` | 输出版本、地址、pid，以及全部项目的编号、标题和工作目录 |
| `eevee web` | 生成一次性授权码，在浏览器里打开面板。授权码 90 秒内有效 |

| 选项 | 作用 |
|---|---|
| `-V`, `--version` | 输出版本号 |
| `-h`, `--help` | 输出帮助 |

`eevee web` 需要 Engine 在运行，没有运行时提示改用 `eevee`；Engine 没运行时，`stop` 和 `status` 只输出“没有在运行。”。命令出错时把错误信息写到 stderr，退出码为 1。

命令行按 [`EEVEE_HOME`](environment-variables.md) 找到数据目录，再从 `runtime/engine.json` 读取 Engine 的端口、从 `runtime/token` 读取 token。

`eevee start` 启动的 Engine 把输出追加到 `runtime/engine.log`，并把当前的 `EEVEE_HOME` 和环境变量传给它。
