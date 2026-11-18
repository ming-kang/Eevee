# 设置

这一页列出 `<数据目录>/settings.json` 的全部设置。所有字段都可以省略，省略时使用默认值。文件位置和生效时机见 [配置](configuration.md)。

用 `eevee model default` 和 `eevee role` 修改的设置立即生效；手动编辑后需要重启 Engine，细节见 [修改后什么时候生效](configuration.md#修改后什么时候生效)。读取和写入时都会按结构校验，格式不对时错误信息会指出具体字段。

## 示例

```json
{
  "$comment": "工作站上的设置",
  "maxActiveWorkers": 4,
  "dreamIntervalMs": 43200000,
  "models": {
    "default": { "provider": "anthropic", "modelId": "<model-id>" },
    "worker": { "provider": "deepseek", "modelId": "<model-id>" },
    "dreamer": { "provider": "deepseek", "modelId": "<轻量模型>" }
  },
  "roles": {
    "router": { "extensions": ["mcp.deepwiki"] },
    "worker": { "extensions": ["mcp.deepwiki", "mcp.github"], "maxTurns": 80 }
  }
}
```

## Engine 与调度

| 设置 | 类型 | 默认值 | 说明 |
|:-:|:-:|:-:|---|
| `port` | 整数，1–65535 | `19190` | Engine 首选的端口。被占用时换一个空闲端口，实际端口写进 `runtime/engine.json` |
| `maxActiveWorkers` | 整数，≥ 1 | `3` | 同时运行的 Worker 上限，超出的工单等待空闲槽位。Router 不占名额 |
| `backgroundAfterMs` | 整数，≥ 0 | `5000` | `bash` 命令在前台运行超过这么多毫秒就转入后台作业 |
| `handoffThreshold` | 数字，大于 0、≤ 1 | `0.6` | 上下文占模型窗口的比例超过它时，Router 空闲时被请求交接，Worker 交收尾报告时顺带重置 |
| `reminderAfterMs` | 整数，≥ 0 | `1800000`（30 分钟） | 收尾报告超过这么久仍未处理，提醒 Router 一次 |
| `dreamIntervalMs` | 整数，≥ 0 | `86400000`（24 小时） | 两次 Dreaming 之间的最短间隔；`0` 关闭 Dreaming |

## 模型

`models` 设置各角色的默认模型。每一项是 `{ "provider": "…", "modelId": "…" }`，可以再加 `"thinkingLevel"`（`off` 到 `max`，见 [思考档位](models.md#思考档位)）。

| 设置 | 说明 |
|:-:|:-:|
| `models.default` | 没有单独设置的角色使用它 |
| `models.router` | Router 的默认模型 |
| `models.worker` | 工单没有指定模型时使用 |
| `models.dreamer` | 整理记忆的工单使用；没有可用模型时 Dreaming 视为关闭 |

项目可以在 `project.json` 里覆盖这些设置，见 [选择模型](models.md#项目的默认模型)。用 `eevee model default` 修改时会检查模型是否存在。

## 角色

`roles.router`、`roles.worker`、`roles.dreamer` 各是一个对象：

| 设置 | 类型 | 默认值 | 说明 |
|:-:|:-:|:-:|:-:|
| `extensions` | 字符串数组 | `[]` | 在角色自带扩展之外启用的扩展名，如 `mcp.deepwiki` |
| `maxTurns` | 整数，≥ 1 | 不限制 | 一次运行最多的工具调用轮次。达到上限时这次运行以失败结束 |

见 [配置角色能力](capabilities.md)。

## 其他

| 设置 | 类型 | 说明 |
|:-:|:-:|:-:|
| `$comment` | 字符串 | 备注，Eevee 忽略它 |
