# 命令行

这一页列出 `eevee` 的全部命令。运行 `eevee --help`，或在任意命令后加 `--help`，可以查看你安装的版本的确切用法。

```sh
eevee start | stop | status | web
eevee project create <title> --workspace <dir>
eevee project say <id> <text...>
eevee project board <id>
eevee project usage <id>
eevee model list
eevee model default <provider/modelId> [--role <role>] [--thinking <level>]
eevee model login <provider>
eevee role list
eevee role enable <role> <extensions...>
eevee role disable <role> <extensions...>
eevee role turns <role> <limit|default>
eevee mcp list | reload
eevee memory log <project> [--global]
eevee memory show <project> [commit] [--global]
eevee memory revert <project> <commit> [--global]
```

`start`、`stop`、`status` 以外的命令都需要 Engine 在运行，没有运行时会提示先执行 `eevee start`；Engine 没运行时，`stop` 和 `status` 只输出“没有在运行。”。命令出错时把错误信息写到 stderr，退出码为 1。

命令行按 [`EEVEE_HOME`](environment-variables.md) 找到数据目录，再从 `runtime/engine.json` 读取 Engine 的端口、从 `runtime/cli-token` 读取 token。

| 选项 | 作用 |
|---|---|
| `-V`, `--version` | 输出版本号 |
| `-h`, `--help` | 输出帮助 |

## Engine

| 命令 | 作用 |
|---|---|
| `eevee start` | 在后台启动 Engine，等它开始接受请求后打印地址。已经在运行时只打印地址。15 秒内没启动成功会报错，并给出日志位置 |
| `eevee stop` | 停止 Engine |
| `eevee status` | 输出版本、地址、pid，以及全部项目的编号、标题和工作目录 |
| `eevee web` | 生成一次性授权码，在浏览器里打开面板。授权码 90 秒内有效 |

`eevee start` 启动的 Engine 把输出追加到 `runtime/engine.log`，并把当前的 `EEVEE_HOME` 和环境变量传给它。

## 项目

| 命令 | 作用 |
|---|---|
| `eevee project create <title> -w <dir>` | 新建项目，关联工作目录 `<dir>`（转换为绝对路径），输出项目编号 |
| `eevee project say <id> <text...>` | 给项目的 Router 发一条消息 |
| `eevee project board <id>` | 列出待回答的问题，以及每张工单（包括已结单的）的编号、[阶段](tickets.md#工单阶段)、标题和运行中的后台作业数 |
| `eevee project usage <id>` | 输出合计、Router、每张工单和每个模型的 token 用量与花费 |

`-w` 是 `--workspace` 的简写，`project create` 必须提供它。

## 模型

| 命令 | 作用 |
|---|---|
| `eevee model list` | 输出默认模型、已配置凭据的 provider 的全部模型（上下文窗口、价格、缓存时长），以及 `models.md` 里的使用经验 |
| `eevee model default <provider/modelId>` | 设置默认模型 |
| `eevee model login <provider>` | 从标准输入读取 API key 并保存到 `auth.json` |

`model default` 的选项：

| 选项 | 作用 |
|---|---|
| `-r`, `--role <role>` | 只为某个角色设置：`router`、`worker` 或 `dreamer`。不加时设置 `default` |
| `-t`, `--thinking <level>` | 思考档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。不加时为 `off` |

模型必须已经存在，写错会被拒绝。`model login` 在终端里运行时会提示输入，但输入的 key 会显示在屏幕上；建议用管道传入：

```bash
echo "$OPENAI_API_KEY" | eevee model login openai
```

## 角色能力

| 命令 | 作用 |
|---|---|
| `eevee role list` | 输出各角色的自带扩展、启用的扩展和轮次上限；全部可启用的扩展；用户扩展的加载错误；MCP 服务器的状态 |
| `eevee role enable <role> <extensions...>` | 为角色启用扩展，如 `mcp.deepwiki`。只能启用已经安装的扩展 |
| `eevee role disable <role> <extensions...>` | 为角色停用扩展 |
| `eevee role turns <role> <limit>` | 设置角色每次运行最多的轮次，正整数；`default` 恢复默认（不限制） |

`<role>` 是 `router`、`worker` 或 `dreamer`。改动立即应用到全部项目的 Router 和未结工单，见 [配置角色能力](capabilities.md)。

## MCP

| 命令 | 作用 |
|---|---|
| `eevee mcp list` | 输出每个 MCP 服务器的扩展名、状态、`exposure`、工具数和错误，以及 `mcp.json` 里的配置问题 |
| `eevee mcp reload` | 重新读取 `mcp.json`，断开并重连全部服务器 |

服务器在后台重连，`reload` 返回时可能还处于 `connecting` 状态，稍后再运行 `eevee mcp list` 查看。见 [接入 MCP 服务器](mcp.md)。

## 记忆

| 命令 | 作用 |
|---|---|
| `eevee memory log <project>` | 输出记忆库最近 20 次提交：commit、时间、说明 |
| `eevee memory show <project> [commit]` | 输出一次提交的改动；不给 `commit` 时输出还没提交的改动（不含新建的文件） |
| `eevee memory revert <project> <commit>` | 撤销一次提交，生成一个新的反向提交。与后来的改动冲突时放弃并报错 |

| 选项 | 作用 |
|---|---|
| `-g`, `--global` | 操作全局记忆库，而不是项目记忆库 |

全局记忆库所有项目共用，但命令仍需要一个项目编号来定位接口。见 [管理记忆](memory.md)。
