# 05 模型接入与画像

## 1. 模型接入

模型接入在 `@earendil-works/pi-ai` 之上自己实现，沿用其配置习惯（细节见 [research/pi-models-auth.md](../research/pi-models-auth.md)）：

- **`~/.eevee/auth.json`**：凭据存储，实现 pi-ai 的 `CredentialStore` 接口。只有引擎单进程写入，用进程内串行队列即可，不需要文件锁。
- **`~/.eevee/models.json`**：自定义 provider、模型覆盖和其他参数，如 `contextWindow`、`promptCache`。
- 组装出的 `Models` 以函数形式传给 Durable 的 `HarnessOptions.models`，修改配置后不用重新打开 Harness。

模型选择分为两层：

1. **默认配置**：项目和角色可以有默认模型，Router 建单时不必每次重复选择。
2. **按对话覆盖**：某项工作确有需要时，Router 可以为 Worker 指定模型，运行中也可以按需要调整。Durable 把模型选择保存在各对话的 `pi.agent` 中。

## 2. 模型画像

用户可以在 `~/.eevee/models.md` 中记录各模型的使用经验：

```markdown
## anthropic/<model-id>
- <使用经验>

## deepseek/<model-id>
- <使用经验>
```

Router 需要为非默认工作选模型时，可以通过 `models://` 查看当前可用模型、`models.json` 里的关键参数（上下文窗口、价格、缓存有效期）和 `models.md` 中对应的经验。

所选模型可以写入 `Ticket.model`；只有非默认选择确有必要时才填写 `modelReason`。模型画像用于辅助判断，不要求每次建单都完成一次模型评审。
