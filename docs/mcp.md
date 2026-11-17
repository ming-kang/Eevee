# 接入 MCP 服务器

Eevee 可以连接 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，支持 stdio 和 streamable HTTP 两种传输，并把它们的工具提供给你指定的角色。每个服务器是一个扩展 `mcp.<name>`，由 Engine 连接一次，所有项目共用。

## 快速设置

1. 在 `~/.eevee/mcp.json` 里写上服务器：

   ```json
   {
     "mcpServers": {
       "deepwiki": { "url": "https://mcp.deepwiki.com/mcp", "exposure": "direct" },
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/papers"]
       }
     }
   }
   ```

2. 重新读取配置并连接，然后检查状态：

   ```bash
   eevee mcp reload
   eevee mcp list
   ```

3. 为角色启用服务器：

   ```bash
   eevee role enable worker mcp.deepwiki mcp.filesystem
   ```

Engine 启动时会自动读取 `mcp.json`；之后修改它，需要运行 `eevee mcp reload`。

## 配置服务器

`mcp.json` 使用其他 MCP 客户端通用的 `mcpServers` 格式，Claude Desktop、Claude Code、Cursor 等客户端的条目可以直接复制过来。Eevee 另外增加了 `exposure` 字段。

stdio 服务器：

| 字段 | 说明 |
|---|---|
| `command` | 可执行文件，不是 shell 命令字符串 |
| `args` | 参数数组 |
| `env` | 额外的环境变量 |
| `cwd` | 工作目录，建议写绝对路径 |

HTTP 服务器：

| 字段 | 说明 |
|---|---|
| `url` | streamable HTTP 端点，常见的是 `/mcp` |
| `headers` | 请求头，比如 `Authorization` |

两种服务器都支持：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `exposure` | `"deferred"` | 工具怎样提供给模型，见 [控制工具暴露](#控制工具暴露) |
| `enabled` | `true` | `false` 时保留条目但不连接，也不会作为扩展出现 |
| `description` | 无 | 一句话说明服务器提供什么。代码模式按它介绍这组工具；不写时使用服务器自己提供的说明的第一行 |
| `timeout` | 无 | 单次请求的超时秒数 |

`type` 可以省略：有 `command` 是 stdio，有 `url` 是 HTTP。旧的 SSE 传输不受支持；提供 SSE 端点的服务器通常也提供 streamable HTTP，地址多半是 `/mcp` 而不是 `/sse`。

### 引用环境变量

`env` 和 `headers` 的值可以引用 Engine 的环境变量，写成 `${NAME}` 或 `$NAME`：

```json
{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

引用的变量没有设置时，这个服务器连接失败并说明原因。变量要在运行 `eevee start` 的环境里设置。

stdio 服务器只继承 `bash` 也能拿到的那些基础环境变量（见 [环境变量](environment-variables.md#子进程继承的变量)），再加上 `env` 里写明的变量。需要的凭据都要在 `env` 里显式传入。

### 配置规则

- 服务器名字只能包含字母、数字、`_` 和 `-`。
- 工具名为 `mcp__<服务器>__<工具>`，字母、数字和 `_` 以外的字符换成 `_`；名字过长或转换后重名时加上哈希后缀。代码模式的分组名为 `mcp__<服务器>`，其中 `-` 换成 `_`，所以不要同时配置只差 `-` 和 `_` 的两个服务器名。
- 配错的条目会被跳过，不影响其他服务器连接，问题显示在 `eevee mcp list` 和 `eevee role list` 里。整个文件不是合法 JSON 时除外：Engine 启动时会因此无法启动；运行中执行 `eevee mcp reload` 会先断开全部服务器再报错，改好文件后要再运行一次。
- 暂不支持 OAuth 登录，也不支持用 `!command` 生成配置值。需要认证的 HTTP 服务器请在 `headers` 里带上 token。

## 控制工具暴露

`exposure` 决定服务器的工具怎样到达模型：

| 值 | 行为 | 适合 |
|---|---|---|
| `deferred` | 默认。工具不放进提示词，模型用 `tool_search` 找到后才能使用 | 工具多的服务器 |
| `direct` | 和其他工具一样直接提供 | 工具少、几乎每次都用的服务器 |
| `codemode` | 只能在 `codemode` 脚本里调用，按服务器分组为 `mcp__<服务器>` | 需要批量调用、组合结果的工具 |
| `hidden` | 保持连接，但不提供任何工具 | 临时停用工具而不断开连接 |

启用 `deferred` 或 `codemode` 服务器的角色会自动带上 `tool-search` 或 `codemode`，不需要手动启用，见 [配置角色能力](capabilities.md#自动带上的扩展)。

## 连接与诊断

Engine 启动时在后台连接全部启用的服务器，不会等它们连上才开始工作。`eevee mcp list` 显示每个服务器的状态：

| 状态 | 含义 |
|---|---|
| `connecting` | 正在连接 |
| `connected` | 已连接，工具可用 |
| `failed` | 连接失败或连接已断开，附带错误信息 |
| `disabled` | `enabled` 为 `false` |

stdio 服务器连接失败时，错误信息会附上它 stderr 的最后一段。

服务器没连上或断开时，它的扩展仍然存在，只是没有工具，角色的配置不受影响。断开后不会自动重连，运行 `eevee mcp reload` 会重新读取 `mcp.json` 并重连全部服务器；重连成功后，工具自动回到启用了它的角色。

MCP 工具的输出太长时，Eevee 保留开头和结尾交给模型，完整内容保存到 `~/.eevee/runtime/mcp-output/`，模型可以用 `read` 打开。

## 安全

stdio 服务器是以你的权限运行的本地程序，HTTP 服务器会收到调用它的角色传来的参数。只接入你信任的服务器，个人凭据通过环境变量引用，不要直接写进 `mcp.json`。见 [安全运行](security.md)。
