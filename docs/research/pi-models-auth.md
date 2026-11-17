# 模型接入：auth.json 与 models.json

参考 pi-coding-agent 的做法和文件格式

Durable 只需要一个 pi-ai `Models`，而内置 provider、登录流程和 `CredentialStore` 接口 pi-ai 都已提供；coding-agent 的 `ModelRuntime` 也是在这些接口上搭出来的。可以直接在 pi-ai 之上自己实现凭据存储和 `models.json` 的读取

- coding-agent 文档：`packages/coding-agent/docs/{models.md, models-configuration.md, providers.md, configuration.md}`
- coding-agent 代码：`packages/coding-agent/src/core/`
- pi-ai 代码：`packages/ai/src/{models.ts, auth/, providers/all.ts}`

## Durable 对模型接入的要求

Durable 只需宿主传一个 pi-ai `Models`

- `HarnessOptions.models: Models | (() => Models)`（`packages/durable/src/harness/types.ts:797`），传函数时每次用到都会调用，所以宿主换掉模型配置不用重新打开 Harness。
- Durable 的 `package.json` 只依赖 pi-ai，README 的示例是 `createModels()` 加 `setProvider(openaiProvider())`，key 从环境变量获取。
- Durable 用到的方法有 `getModel`、`getModelOfType`、`getModelsOfType`、`getAvailableOfType`、`streamSimple`、`completeSimple`、`fetchDeferred`、`cancelDeferred`、`generateImages`、`classify`，pi-ai 的 `createModels()` 全都实现了。

## pi-ai 提供的部分

| 接口 | 位置 | 作用 |
|---|---|---|
| `builtinProviders()`、`builtinModels(options)` | `ai/src/providers/all.ts:137`、`:186` | 全部内置 provider，各自带模型目录、请求实现和登录方式（API key、OAuth）。包入口是 `@earendil-works/pi-ai/providers/all` |
| `createModels({ credentials, modelsStore?, identity? })` | `ai/src/models.ts:1059` | 返回 `MutableModels`，用 `setProvider` 注册 provider |
| `createProvider({ id, baseUrl, auth, models, api })` | `ai/src/models.ts:1108` | 组装 provider；内置 provider 也是用它造的。返回普通的闭包对象，不依赖 `this`，可以用展开语法包一层 |
| `CredentialStore` 接口、`InMemoryCredentialStore` | `ai/src/auth/types.ts:65`、`ai/src/auth/credential-store.ts` | 应用自己实现持久化的凭据存储；内存版可以当模板 |
| `Models.login()`、`Models.logout()` | `ai/src/models.ts:327` | 执行 provider 的登录流程，结果经 `CredentialStore.modify` 存下 |
| `envApiKeyAuth()`、`lazyOAuth()` | `ai/src/auth/helpers.ts` | 拼装 provider 认证的辅助函数 |
| `openAICompletionsApi()` 等 | `ai/src/api/*.lazy.ts` | 各 API 的 lazy 实现，自定义 provider 按 `api` 字段选用 |

## 配置文件

| 文件 | 内容 | 写入方 |
|---|---|---|
| `<agent-dir>/auth.json` | 每个 provider 一份凭据：`{ type: "api_key", key, env? }` 或 `{ type: "oauth", refresh, access, expires, ... }` | `/login`、`/logout`、OAuth 刷新 |
| `<agent-dir>/models.json` | 自定义 provider 和模型，以及对内置模型的覆盖；不存放凭据，但可以引用凭据 | 可以手动编辑 |

### auth.json

- 凭据类型定义在 pi-ai 里（`packages/ai/src/auth/types.ts`）：`Credential = ApiKeyCredential | OAuthCredential`，即 "the shape of today's auth.json"。

### models.json

- `providers.<id>`：内置 id 表示修改该 provider，其他 id 表示新增 provider（需要 `baseUrl` 和 `api`）。
- provider 级字段：`baseUrl`、`api`、`apiKey`、`headers`、`compat`、`authHeader`、`models`、`modelOverrides`。
- 模型字段：
  - `contextWindow`、`maxTokens`：上下文阈值
  - `cost`，包括 `cacheRead`、`cacheWrite` 和按输入量分档的 `tiers`：缓存画像的权重从这里推算。
  - `reasoning`、`thinkingLevelMap`：思考档位。
  - `compat`：各 API 的兼容开关
- `modelOverrides.<modelId>`：只改内置模型的部分字段；对象字段（如 `cost`）逐字段合并。
- `"$schema": "https://pi.dev/schemas/models.schema.json"`
