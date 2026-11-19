# 模型

## 1. 模型接入

模型接入基于 `@earendil-works/pi-ai` 实现：

- **`~/.eevee/auth.json`**：凭据存储。
- **`~/.eevee/models.json`**：自定义 provider、模型覆盖和其他参数。

模型选择分为两层：

1. **默认配置**：角色默认模型。
2. **按对话覆盖**：某项工作确有需要时，Router 可以为 Worker 指定模型，运行中也可以按需要调整。

## 2. 模型画像

用户可以在 `~/.eevee/models.md` 中记录各模型的使用经验，形如：

```markdown
## anthropic/<model-id>
- <notes>

## deepseek/<model-id>
- <notes>
```

Router 需要为非默认工作选模型时，可以通过 `models://` 查看当前可用模型、`models.json` 里的关键参数和 `models.md` 中对应的经验。
