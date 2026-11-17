# 安全运行

Eevee 采用 YOLO 权限工作，无需审批命令。

## 本地接口的防护

Engine 的本地接口能让 Worker 执行任意命令，出于安全考虑，Eevee 为此做了这些限制：

- **监听回环地址**：只绑定 `127.0.0.1`，并要求请求的 `Host` 和 `Origin`（如果有）都是回环地址，防止 DNS 重绑定和网页跨站请求。
- **接口需要鉴权**：只有健康检查和授权码兑换不需要 token。命令行使用 `runtime/cli-token` 里的 token，浏览器使用会话 token，两者都放在 `x-eevee-token` 请求头里。
- **敏感操作通过终端**：停止 Engine、生成授权码、保存凭据等操作只接受 CLI token。
- **浏览器授权**：`eevee web` 生成的授权码 90 秒内有效，会话 12 小时无操作后过期，Engine 只保存会话 token 的哈希。
- **实时流**：Token 放在子协议里，Engine 只回应 `eevee.v1`，不会回显 Token。

## 子进程的环境变量

`bash` 命令、后台作业和 stdio MCP 服务器不继承 Engine 的全部环境变量，只继承 `PATH`、`HOME`、`TEMP`、`LANG` 等基础变量（完整列表见 [环境变量](environment-variables.md#子进程继承的变量)）。Provider 的 API key 等 Engine 持有的凭据不会主动传给它们。

## 私有文件

`auth.json`、`settings.json`、`runtime/cli-token`、`runtime/sessions.json` 等私有文件都先写临时文件再改名，原子替换；在 POSIX 系统上权限为 `0600`。

## 扩展与 MCP 服务器

- **用户扩展**在 Engine 进程里运行，拥有 Engine 的全部权限，能看到所有项目的对话和凭据。只放你信任的代码。
- **stdio MCP 服务器**作为 Engine 的子进程运行，`env` 里引用的变量会传给它。**HTTP MCP 服务器**会收到调用它的角色传来的参数，以及你在 `headers` 里配置的 token。

## 不受信任的内容

工作目录里的文件、网页、MCP 工具输出、对话记录和记忆笔记都可能包含诱导模型执行危险操作的文字。Eevee 的提示词把对话记录和记忆当作数据而不是指令，但这不能完全防止提示注入。处理不受信任的内容时，在隔离环境里运行。
