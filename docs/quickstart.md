# 快速开始

Eevee 以后台进程的形式运行在电脑上，可以通过 `eevee` 命令和浏览器面板使用它。

开始之前，你需要一个可用的模型：内置 Provider 的 API Key/Oauth，或者一个兼容 OpenAI、Anthropic 格式的端点。

## 1. 安装 Eevee

需要：

- **Node.js 26 或更高版本**。
- **Git**。记忆库是 Git 仓库，Eevee 调用 `git` 提交和撤销改动。
- **bash**。Worker 的 `bash` 工具在 bash 里执行命令。Windows 上需要安装 [Git for Windows](https://git-scm.com/download/win)：Eevee 优先使用它装在默认位置的 `bash.exe`，找不到时才用 `PATH` 上的第一个 `bash.exe`。

Eevee 尚未发布到 npm，需要从源码构建。在源码目录里运行：

```bash
npm install
npm run build
npm link
```

`npm link` 把 `eevee` 命令装到全局。不想装到全局时，可以把下文的 `eevee` 换成 `node dist/cli/index.js`。

确认安装成功：

```bash
eevee --version
```

## 2. 启动 Engine

```bash
eevee start
```

Engine 在后台启动，只监听 `127.0.0.1`，默认端口是 `19190`，被占用时会换一个空闲端口。命令会打印实际地址。随时可以查看运行状态：

```bash
eevee status
```

Engine 的输出写在 `~/.eevee/runtime/engine.log`。所有数据都在 `~/.eevee/` 下，用环境变量 [`EEVEE_HOME`](environment-variables.md) 可以换一个位置。

## 3. 连接模型

把 provider 的 API key 交给 Engine 保存：

```bash
echo "$ANTHROPIC_API_KEY" | eevee model login anthropic
```

也可以不保存凭据，在运行 `eevee start` 的终端里设置 provider 的环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。

查看可用的模型，并选一个作为默认模型：

```bash
eevee model list
eevee model default anthropic/<model-id>
```

没有默认模型时，Router 无法开始工作：发给它的消息会以“没有配置模型”失败，设置好默认模型后在面板上重试即可。本地模型和兼容端点的接法见 [选择模型](models.md)。

## 4. 创建项目

一个项目对应一项持续的工作，关联你自己的一个工作目录。Worker 的产物默认写在这个目录里。目录需要事先存在，Eevee 不会替你创建。

```bash
eevee project create "光学论文" --workspace ~/papers/optics
```

命令会打印项目编号，例如 `p3f9a1c2e`。之后的命令都用这个编号指定项目。

## 5. 交给 Eevee 一项工作

在浏览器里打开面板：

```bash
eevee web
```

这条命令会生成一个 90 秒内有效的一次性授权码，并用它打开面板。在面板里选中项目，直接告诉 Router 你要做什么，例如：

```text
帮我检查 draft.tex 里的公式编号是否连续，有问题就改好。
```

```text
跑一遍 simulate.py 的参数扫描，把结果整理成表格放进 results/。
```

Router 会在需要时建立工单，交给 Worker 执行。你也可以在终端里给 Router 发消息、查看工单：

```bash
eevee project say p3f9a1c2e 把 README 里过时的安装说明更新一下
eevee project board p3f9a1c2e
```

Worker 不会在每次执行命令或修改文件前征求同意。重要的工作目录请放在版本控制里，或者先做好备份，见 [安全运行](security.md)。

## 停止 Engine

Engine 会一直在后台运行，关闭面板不影响进行中的工作。停止 Engine：

```bash
eevee stop
```

再次 `eevee start` 时，被打断的工作会接着进行；被打断的后台命令会通知对应的 Worker，由它决定是否重跑。

## 下一步

- [日常使用](usage.md)：回答问题、观察和引导 Worker、查看花费。
- [工单与报告](tickets.md)：理解工单的阶段和什么时候需要你。
- [配置角色能力](capabilities.md)：给 Worker 接上 MCP 服务器或你自己的扩展。

## 卸载

如果用 `npm link` 安装过，在源码目录里运行：

```bash
npm unlink -g @astralyn/eevee
```

卸载不会删除 `~/.eevee/` 里的配置、凭据、项目记录和记忆库。需要彻底清除时，先 `eevee stop`，再手动删除这个目录。
