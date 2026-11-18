# 模型配置

这一页列出 `~/.eevee/models.json` 的全部字段。它的格式是 pi coding agent `models.json` 的一个子集，常见场景见 [选择模型](models.md#接入兼容端点)。

`models.json` 在 Engine 启动和保存 API Key 时读取，问题写进 Engine 日志：

- 字段类型或结构不符合下面的定义时，整个文件都不生效，日志里给出字段路径；
- 结构正确但组不成 provider（比如新增的 provider 缺 `baseUrl` 或 `api`，或 `api` 不认识）时，只影响那一个 provider：内置 provider 保持原样，新增的 provider 不会出现；
- 文件不是合法 JSON 时，Engine 无法启动。

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen3", "contextWindow": 32768 }]
    },
    "anthropic": {
      "modelOverrides": { "<model-id>": { "contextWindow": 500000 } }
    }
  }
}
```

顶层字段：

| 字段 | 说明 |
|---|---|
| `providers` | 以 provider 名字为键的对象 |
| `$schema` | 可选，Eevee 忽略它 |

## Provider

用内置 provider 的名字（如 `anthropic`、`openai`、`deepseek`）是修改它，其他名字是新增 provider。

| 字段 | 类型 | 说明 |
|:-:|:-:|---|
| `name` | 字符串 | 显示名称 |
| `baseUrl` | 字符串 | API 地址。新增 provider 必填；修改内置 provider 时，它的全部模型改走这个地址 |
| `api` | 字符串 | 模型使用的 API，见 [API](#api)。新增 provider 时必须在这里或每个模型上指定 |
| `apiKey` | 字符串 | API key，可以引用环境变量 |
| `headers` | 对象 | 每个请求附加的请求头，值可以引用环境变量 |
| `authHeader` | 布尔 | `true` 时加上 `Authorization: Bearer <API key>` |
| `models` | 数组 | 新增或替换的模型，见 [模型](#模型) |
| `modelOverrides` | 对象 | 以模型编号为键，修改已有模型的字段，见 [模型覆盖](#模型覆盖) |

新增的 provider 至少要有一个模型。没有 `apiKey`、也没有登录或环境变量提供凭据时，它的模型不会出现在可用列表里。

### 认证顺序

同一个 provider 按这个顺序取第一个可用的凭据：

1. 在面板里保存、存在 `auth.json` 里的凭据；
2. 这里的 `apiKey`；
3. 内置 provider 自己的方式，通常是环境变量，见 [环境变量](environment-variables.md#provider-凭据)。

`apiKey` 引用的环境变量没有设置时，视为没有配置 `apiKey`。`headers` 引用的环境变量没有设置时，请求失败并说明是哪个请求头。

### 引用环境变量

`apiKey` 和 `headers` 的值可以包含 `$NAME` 或 `${NAME}`，在发出请求时替换为 Engine 进程里对应环境变量的值：

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "${GATEWAY_KEY}",
      "headers": { "x-team": "${TEAM_ID}" },
      "models": [{ "id": "general-large" }]
    }
  }
}
```

## 模型

`models` 里的每一项新增一个模型。编号与已有模型相同时整个替换它：没写的字段取下表的默认值，不继承原来的模型。只想改几个字段时用 [模型覆盖](#模型覆盖)。

| 字段 | 类型 | 默认值 | 说明 |
|:-:|:-:|:-:|---|
| `id` | 字符串 | 必填 | 模型编号，也是请求里发送的模型名 |
| `name` | 字符串 | 同 `id` | 显示名称 |
| `api` | 字符串 | provider 的 `api` | 这个模型使用的 API |
| `baseUrl` | 字符串 | provider 的 `baseUrl` | 这个模型的 API 地址 |
| `reasoning` | 布尔 | `false` | 是否支持推理 |
| `input` | `("text" \| "image")[]` | `["text"]` | 接受的输入类型 |
| `contextWindow` | 数字 | `128000` | 上下文窗口，单位 token。Eevee 按它计算 `handoffThreshold` |
| `maxTokens` | 数字 | `16384` | 单次输出的最大 token 数 |
| `cost` | 对象 | 全为 `0` | 价格，单位美元 / 百万 token：`input`、`output`、`cacheRead`、`cacheWrite` |
| `promptCache` | 对象 | 无 | 提示词缓存的有效期，单位秒：`short`、`long` |
| `headers` | 对象 | 无 | 这个模型的请求附加的请求头 |

`cost` 决定花费统计里估算的金额；provider 返回实际计费时，以实际计费为准。

## 模型覆盖

`modelOverrides` 修改已有模型（内置的，或本文件 `models` 里的），只改写明的字段，其他字段保持不变。编号不存在的条目会被忽略。

可以覆盖的字段：`name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`、`promptCache`、`headers`。其中 `cost`、`promptCache` 和 `headers` 逐个子字段合并：

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "<model-id>": { "cost": { "input": 3 }, "contextWindow": 200000 }
      }
    }
  }
}
```

上面只改了输入价格和上下文窗口，输出价格等其他字段保持内置的值。

## API

`api` 可以是：

| 值 | 适用于 |
|:-:|:-:|
| `openai-completions` | OpenAI Chat Completions 兼容的服务：Ollama、LM Studio、vLLM、SGLang 和大多数代理 |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API 及兼容服务 |
| `google-generative-ai` | Google Gemini API |
| `google-vertex` | Google Vertex AI |
| `bedrock-converse-stream` | Amazon Bedrock Converse |
| `mistral-conversations` | Mistral Conversations API |
| `pi-messages` | Pi Messages API |

修改内置 provider 时，如果模型使用该 provider 本来就支持的 API，请求仍由内置实现处理，保留它的认证和兼容性处理。
