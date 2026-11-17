# Eevee

Eevee 是一个运行在你自己电脑上的主动型智能体（Proactive Agent）。

你只需要和调度者（Router）对话，它会把工作拆成工单，交给在后台运行的执行者（Worker），再汇总报告、验收结果，并把长期有用的经验录入记忆库。

Eevee 适合持续一段时间、由许多性质不同的子任务组成的工作，比如维护代码仓库、写论文、跑仿真和整理数据。

> Eevee 还处于开发初期（`0.0.1`），尚未发布到 npm。命令、配置和接口都可能变化。

## 开始使用

第一次用 Eevee，可以先按 [快速开始](quickstart.md) 安装、连接模型，并完成第一项工作。

已经装好了，可以按要做的事选择：

- [日常使用](usage.md)：和 Router 对话、回答问题、观察和引导 Worker、查看花费。
- [使用面板](web.md)：面板的布局、各个页面和快捷键。
- [工单与报告](tickets.md)：工单怎样推进、各阶段是什么意思、什么时候需要你出面。
- [选择模型](models.md)：登录 provider、设置默认模型、接入本地或兼容端点。
- [管理记忆](memory.md)：记忆库里存什么、怎样手动修改、怎样撤销一次记错的笔记。
- [Eevee 如何工作](how-eevee-works.md)：Engine、项目、工单、上下文和持久化。

## 定制 Eevee

- [配置](configuration.md)：数据目录里每个文件的作用，以及修改后什么时候生效。
- [配置角色能力](capabilities.md)：为 Router 或 Worker 启用 MCP 服务器和扩展、限制每次运行的轮次。
- [接入 MCP 服务器](mcp.md)：用常见 MCP 客户端的配置格式接入 stdio 或 HTTP 服务器。

## 基于 Eevee 开发

- [编写扩展](extensions.md)：给 Eevee 加你自己的工具。
- 用 [命令行](cli.md) 在脚本里管理 Engine、项目、模型和记忆。
- 用 [HTTP 接口](http-api.md) 和 [实时流](stream.md) 写自己的客户端，见 [接入本地接口](integration.md)。
- 想修改 Eevee 本身，见 [参与开发](development.md)。

## 查找参考

参考页列出 [命令行](cli.md)、[设置](settings.md)、[模型配置](models-configuration.md)、[环境变量](environment-variables.md)、[内置工具](tools.md)、[资源地址](addresses.md)、[HTTP 接口](http-api.md) 和 [实时流](stream.md) 的全部内容。

遇到问题时，先看 [排查问题](troubleshooting.md)。

## 安全使用

Eevee 采用 YOLO 权限工作：Worker 的 `bash`、`write`、`edit` 以 Engine 进程的权限运行，不逐次请求确认，也没有内置沙箱。处理不受信任的仓库、文件、MCP 服务器或扩展之前，先读 [安全运行](security.md)。
