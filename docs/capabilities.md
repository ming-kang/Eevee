# 配置角色能力

Eevee 的每个对话都属于一种角色：Router、Worker，或者整理记忆用的 `dreamer`。角色的能力由它选用的扩展决定，除了每个角色自带的扩展外，还可以为它启用 MCP 服务器和新扩展。

## 角色自带的扩展

| 角色 | 自带扩展 | 提供的工具 |
|---|---|---|
| `router` | `eevee.resources`、`eevee.dispatch`、`eevee.memory`、`eevee.router` | `read`、`ticket`、`ask_user`、`memory`、`handoff` |
| `worker` | `eevee.resources`、`eevee.workspace`、`eevee.report` | `read`、`write`、`edit`、`bash`、`report` |
| `dreamer` | `eevee.resources`、`eevee.memory-project`、`eevee.report` | `read`、只能整理项目记忆的 `memory`、`report` |

自带扩展总是选中，各工具的参数见 [内置工具](tools.md)。

## 可启用的扩展

| 扩展 | 来源 |
|---|---|
| `mcp.<name>` | `mcp.json` 里的每个 MCP 服务器，见 [接入 MCP 服务器](mcp.md) |
| 扩展自己的名字 | `extensions/` 里的每个用户扩展，见 [编写扩展](extensions.md) |
| `tool-search` | 工具搜索：模型用 `tool_search` 找到延迟加载的工具后再使用 |
| `codemode` | 代码模式：模型写脚本批量调用工具 |

查看全部可启用的扩展、各角色当前的配置、MCP 服务器的连接状态和用户扩展的加载错误：

```bash
eevee role list
```

```text
router：eevee.resources、eevee.dispatch、eevee.memory、eevee.router + mcp.deepwiki
worker：eevee.resources、eevee.workspace、eevee.report + mcp.deepwiki、mcp.github，每次最多 80 轮
dreamer：eevee.resources、eevee.memory-project、eevee.report

可启用：
  tool-search（1 个工具）
  codemode（3 个工具）
  mcp.deepwiki（3 个工具）
  mcp.github（26 个工具）
  clock（1 个工具）

MCP：
  mcp.deepwiki [connected] direct，3 个工具
  mcp.github [connected] deferred，26 个工具
```

## 启用和停用扩展

```bash
eevee role enable worker mcp.github mcp.deepwiki
eevee role enable router mcp.deepwiki
eevee role disable worker mcp.deepwiki
```

只能启用已经安装的扩展，名字写错会被拒绝。改动保存在 `settings.json` 的 `roles` 里，立即应用到所有项目的 Router 和全部未结工单：

```json
{
  "roles": {
    "router": { "extensions": ["mcp.deepwiki"] },
    "worker": { "extensions": ["mcp.github", "mcp.deepwiki"], "maxTurns": 80 }
  }
}
```

手动编辑 `settings.json` 也可以，重启 Engine 后生效。手动写入的名字如果没有安装，应用角色时会跳过它并写进日志。

### 自动带上的扩展

应用角色时，Eevee 检查选中的工具：

- 有延迟加载的工具（比如 `exposure` 为 `deferred` 的 MCP 服务器），就自动带上 `tool-search`；
- 有只给脚本调用的工具（比如 `exposure` 为 `codemode` 的 MCP 服务器），就自动带上 `codemode`。

所以一般不需要手动启用这两个扩展。想让 Worker 用脚本批量调用它的全部工具时，可以显式启用 `codemode`。

### MCP 服务器还没连上时

MCP 服务器在后台连接。没连上或者断开的服务器，它的扩展仍然存在，只是没有工具；角色可以照常启用它，连上之后工具自动出现，不需要重新配置。

## 限制每次运行的轮次

`maxTurns` 限制一次运行最多有多少个工具调用轮次。达到上限的那个轮次会执行完它的工具，然后这次运行以失败结束；工单的 Worker 会因此得到一份 `failed` 报告，Router 被唤醒决定是否继续。

```bash
eevee role turns worker 80
eevee role turns worker default   # 恢复默认：不限制
```

## 对缓存的影响

改变能力会改变模型看到的工具列表，可能让这个角色的缓存前缀失效一次。Eevee 优先保证每个角色拿到它需要的能力，而不是为了缓存限制能力。通过 `tool_search` 加载过的工具在配置更新后继续可用。

启用扩展只决定角色能用哪些能力，不是权限系统，也不会增加确认步骤。见 [安全运行](security.md)。
