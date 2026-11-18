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

## 2. 启动 Eevee

```bash
eevee
```

这条命令在后台启动 Engine，然后在浏览器里打开面板。Engine 只监听 `127.0.0.1`，默认端口是 `19190`，被占用时会换一个空闲端口，命令会打印实际地址。

打开面板时使用一次性授权码（有效期 90s）。授权一次后，这个浏览器会记住，之后直接打开打印出的地址或书签即可；换了浏览器，或者 Engine 换了端口，再运行一次 `eevee`。随时可以查看运行状态：

```bash
eevee status
```

Engine 的输出写在 `~/.eevee/runtime/engine.log`。所有数据都在 `~/.eevee/` 下，用环境变量 [`EEVEE_HOME`](environment-variables.md) 可以换一个位置。

## 3. 连接模型

在面板左栏底部打开“设置”，切到“模型”页，在 provider 那一行点“填写 API Key”，粘贴后保存。Engine 把 key 保存在 `~/.eevee/auth.json` 里。

也可以不保存凭据，改用 provider 的环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。Engine 只读取启动时的环境变量，所以要在设置好变量的终端里先 `eevee stop`，再运行 `eevee`。

配置好凭据后，“可用模型”里会列出这个 provider 的模型。在同一页顶部为“全局默认”选一个模型。

没有默认模型时，Router 无法开始工作：发给它的消息会以“没有配置模型”失败，设置好默认模型后在面板上重试即可。本地模型和兼容端点的接法见 [选择模型](models.md)。

## 4. 创建项目

一个项目对应一项持续的工作，关联你自己的一个工作目录。Worker 的产物默认写在这个目录里。目录需要事先存在，Eevee 不会替你创建。

点左栏顶部的“新建项目”，填写标题和工作目录即可。

## 5. 交给 Eevee 一项工作

在面板里选中项目，直接告诉 Router 你要做什么，例如：

```text
帮我检查 draft.tex 里的公式编号是否连续，有问题就改好。
```

```text
跑一遍 simulate.py 的参数扫描，把结果整理成表格放进 results/。
```

Router 会在需要时建立工单，交给 Worker 执行，工单列在右栏。

Worker 不会在每次执行命令或修改文件前征求同意。重要的工作目录请放在版本控制里，或者先做好备份，见 [安全运行](security.md)。

## 停止 Engine

Engine 会一直在后台运行，关闭面板不影响进行中的工作。停止 Engine：

```bash
eevee stop
```

再次运行 `eevee` 或 `eevee start` 时，被打断的工作会接着进行；被打断的后台命令会通知对应的 Worker，由它决定是否重跑。

## 下一步

- [日常使用](usage.md)：回答问题、观察和引导 Worker、查看花费。
- [工单与报告](tickets.md)：理解工单的阶段，以及什么时候会向你提问。
- [配置角色能力](capabilities.md)：给 Worker 接上 MCP 服务器或你自己的扩展。

## 卸载

如果用 `npm link` 安装过，在源码目录里运行：

```bash
npm unlink -g @astralyn/eevee
```

卸载不会删除 `~/.eevee/` 里的配置、凭据、项目记录和记忆库。需要彻底清除时，先 `eevee stop`，再手动删除这个目录。
