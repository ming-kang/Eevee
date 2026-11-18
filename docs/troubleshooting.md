# 排查问题

这一页按现象列出常见问题的原因和解决办法。多数问题的线索都在 Engine 日志里：

```bash
tail -f ~/.eevee/runtime/engine.log
```

设置了 [`EEVEE_HOME`](environment-variables.md) 时，日志在 `<数据目录>/runtime/engine.log`。

## Engine

| 现象 | 原因与解决办法 |
|---|---|
| `eevee start` 报“启动超时” | 先运行 `eevee status`：项目多或者要恢复的工作多时，Engine 可能超过 15 秒才开始监听，其实已经起来了。没有起来时看日志末尾，常见原因见下面三行 |
| 日志里是“`settings.json` 格式不对”之类的字段错误 | 按错误里的文件和字段改好，再 `eevee start` |
| 日志里是不带文件名的 JSON 语法错误，比如 `Expected double-quoted property name in JSON` | `settings.json`、`models.json`、`mcp.json` 或某个项目的 `project.json` 不是合法 JSON，任何一个都会让 Engine 无法启动。逐个检查这几个文件 |
| 日志里是“Eevee 已经在运行（pid N）” | `runtime/engine.lock` 记录的进程 N 还活着，但没有响应，这时 `eevee stop` 也停不掉它。N 是卡住的 Engine 时，结束这个进程；N 不是 Eevee（进程号被别的程序复用了）时，删除 `<数据目录>/runtime/engine.lock`。然后重新 `eevee start` |
| 命令提示“Eevee 没有在运行” | 运行 `eevee start`。用了 `EEVEE_HOME` 时，确认每个终端设置的是同一个目录 |
| 改了 `settings.json` 没有生效 | 手动编辑后要重启 Engine 才生效：`eevee stop && eevee start`。见 [修改后什么时候生效](configuration.md#修改后什么时候生效) |
| 改了环境变量没有生效 | Engine 只读取启动时的环境变量。在运行 `eevee start` 的终端里设置好，再重启 Engine |

## 模型

| 现象 | 原因与解决办法 |
|---|---|
| Router 不回应，对话显示“没有配置模型” | 用 `eevee model default` 设置默认模型，然后在面板上重试那一轮 |
| 对话以其他原因失败 | 面板会显示失败原因，常见的是凭据无效或 provider 报错。修好后在面板上重试 |
| `eevee model list` 里没有某个 provider 的模型 | 只列出已经配置凭据的 provider。用 `eevee model login` 保存 API key，或在运行 `eevee start` 的环境里设置它的环境变量 |
| `eevee model default` 报“没有模型” | provider 或模型编号写错了，用 `eevee model list` 查看确切的写法 |
| 改了 `models.json` 没有生效 | `models.json` 在 Engine 启动和 `eevee model login` 时读取，问题写进日志。字段类型或结构写错时整个文件都不生效；结构正确但组不成 provider（比如缺 `baseUrl`）时只影响那一个 provider |

## 面板

| 现象 | 原因与解决办法 |
|---|---|
| 页面提示“还没有授权” | 这个标签页里没有会话：直接打开了不带授权码的地址，或者是新开的标签页（会话只保存在当前标签页）。重新运行 `eevee web` |
| 页面提示“授权码无效或已过期” | 授权码只能用一次，90 秒内有效。重新运行 `eevee web` |
| 页面提示“需要授权” | 会话超过 12 小时无操作，已经过期。重新运行 `eevee web` |
| 页面返回“WebUI 尚未构建” | 在源码目录里运行 `npm run build` |
| 面板上没有输入框 | 有待回答的问题时，问题卡片代替了输入框。先回答问题，或者点“稍后”把卡片收起来再发消息 |
| 左栏底部显示“正在重新连接…” | 面板和 Engine 之间的实时连接断了，期间看到的可能不是最新状态。面板会自动重连；一直连不上时用 `eevee status` 确认 Engine 还在运行 |

## 工单

| 现象 | 原因与解决办法 |
|---|---|
| 工单一直是 `queued` | 同时运行的 Worker 达到 [`maxActiveWorkers`](settings.md) 上限，等其他工单结束本轮后再开始。你回答了工单的问题、后台作业结束时，空闲的工单也要等槽位 |
| 工单停在 `review` 或 `blocked` | 在等 Router 处理。报告超过 [`reminderAfterMs`](settings.md) 仍未处理时，Engine 会在 Router 空闲时提醒它一次；提醒过还没处理，就在主对话里直接让它处理 |
| 工单停在 `answer` | 在等你回答问题 |
| Worker 的 `bash` 报 “No bash shell found” | Windows 上没有找到 bash。安装 Git for Windows，然后重启 Engine |
| Worker 的命令找不到某个环境变量 | `bash` 只继承基础环境变量，见 [环境变量](environment-variables.md#子进程继承的变量) |

## MCP 与扩展

| 现象 | 原因与解决办法 |
|---|---|
| `eevee mcp list` 显示 `failed` | 看它附带的错误和 stderr。修好后运行 `eevee mcp reload` |
| `eevee mcp reload` 报错后所有服务器都不见了 | `mcp.json` 不是合法 JSON。重新读取之前会先断开全部连接，所以改好文件后再运行一次 `eevee mcp reload` |
| 错误是“引用的环境变量没有设置” | 在运行 `eevee start` 的环境里设置这个变量，然后重启 Engine |
| 服务器断开后工具消失 | 断开后不会自动重连，运行 `eevee mcp reload` |
| `eevee role list` 里有 ✗ 开头的行 | `✗ mcp.json：` 开头的是 `mcp.json` 的配置问题，修好后运行 `eevee mcp reload`。其他 ✗ 行是扩展文件加载失败，行里写着文件和原因，修好后重启 Engine |
| `eevee role enable` 报“没有安装扩展”，提到的却不是你这次写的名字 | 这个角色已启用的某个扩展已经不存在了，比如删掉了对应的 MCP 服务器。先用 `eevee role disable <角色> <名字>` 去掉它 |

## 还是解决不了

运行 `eevee status` 确认版本（Engine 没有运行时用 `eevee --version`），并查看日志里出错前后的内容。分享日志之前先检查一遍，里面可能包含文件路径、命令输出和配置信息。
