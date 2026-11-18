# 选择模型

Eevee 在 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) 之上接入模型，可以使用它内置的 provider。内置 provider 只需要提供 API key，然后选一个默认模型；只有 Eevee 不认识的 provider 或端点才需要写 `models.json`。目前只支持 API key 认证，需要浏览器登录（OAuth）的订阅还不能使用。

## 选择接入方式

| 你有什么 | 推荐做法 |
|:-:|:-:|
| 内置 Provider 的 API Key | `eevee model login <provider>`，或设置环境变量 |
| 其他本地或云端网关 | 在 `models.json` 里[添加兼容端点](#接入兼容端点) |


## 认证

把 API key 交给 Engine 保存在 `~/.eevee/auth.json`：

```bash
echo "$DEEPSEEK_API_KEY" | eevee model login deepseek
```

在终端里直接运行 `eevee model login deepseek` 时，它会提示你输入，但输入的 key 会显示在屏幕上，所以更推荐用管道传入。这条命令只能由命令行调用，浏览器面板无法读取或写入凭据。

也可以不保存，在运行 `eevee start` 的环境里设置 provider 的环境变量，比如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`。常见变量见 [环境变量](environment-variables.md#provider-凭据)。

同一个 provider 配置了多个凭据来源时，按这个顺序取第一个可用的：

1. `eevee model login` 保存在 `auth.json` 里的凭据；
2. `models.json` 里该 provider 的 `apiKey`；
3. provider 的环境变量或云平台的默认凭据。

`auth.json` 以私有权限原子写入。不要把它放进同步盘或版本控制。

## 设置默认模型

```bash
eevee model list
eevee model default anthropic/<model-id>
```

`eevee model list` 列出当前默认模型、所有已配置凭据的 provider 的模型及其上下文窗口、价格和缓存时长，以及你在 `models.md` 里记录的使用经验。

默认模型可以按角色分别设置：

```bash
eevee model default deepseek/<model-id> --role worker
eevee model default <provider>/<轻量模型> --role dreamer
```

改动立即应用到全部项目的 Router 和没有指定模型的工单。

### 思考档位

支持推理的模型可以设思考档位，从低到高为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，不设为 `off`。档位跟着模型走，写在同一处：

```bash
eevee model default anthropic/<model-id> --role worker --thinking high
```

`settings.json` 与 `project.json` 里写作 `"thinkingLevel": "high"`。模型不支持的档位由 provider 换成最接近的一档；`eevee model list` 和 `models://` 列出每个模型支持的档位。

### 项目的默认模型

在面板里，输入框左下角的按钮显示当前项目 Router 的模型和思考档位，点开可以换；选择写进这个项目的 `project.json`，选“默认”则回到全局设置。也可以直接编辑 `~/.eevee/projects/<项目>/project.json`，加上 `models`，然后重启 Engine：

```json
{
  "id": "p3f9a1c2e",
  "title": "光学论文",
  "workspace": "/home/me/papers/optics",
  "createdAt": 1763366400000,
  "models": {
    "default": { "provider": "anthropic", "modelId": "<model-id>" },
    "worker": { "provider": "deepseek", "modelId": "<model-id>" }
  }
}
```

为某个角色选模型时，先看 `project.json`，再看 `settings.json`；每一层先找这个角色自己的设置，再找 `default`。所以项目的 `default` 优先于全局按角色设置的模型。

Dreaming 没有可用的模型时，视为关闭。

## 工单的模型

Router 建单时可以为工单指定模型和思考档位，选非默认模型时写明理由；工单进行中也可以用 `ticket model` 换模型或档位，从下一次模型请求起生效。不指定时，工单跟随 Worker 的默认模型。

Router 用 `read models://` 查看可用模型和你记录的经验。格式与 `eevee model list` 相同，但默认模型一栏列出的是这个项目里每个角色实际使用的模型，已经合并了 `project.json` 的设置。

## 记录模型的使用经验

在 `~/.eevee/models.md` 里按模型记录使用经验，Router 选模型时会看到：

```markdown
## anthropic/<model-id>
- 长文档修改稳定，适合论文工单
- 贵，简单检索类工作不要用

## deepseek/<model-id>
- 代码任务性价比高
- 偶尔忽略验收标准里的格式要求，建单时写清楚
```

这个文件每次读取时重新加载，修改后不需要重启。它只是辅助判断，不要求 Router 每次建单都评审一遍模型。

## 接入兼容端点

服务兼容 Eevee 已支持的 API 时，在 `~/.eevee/models.json` 里新增一个 provider：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen3", "contextWindow": 32768 }]
    }
  }
}
```

Ollama 不检查 key，`apiKey` 填任意值即可让模型变为可用。需要认证的端点，`apiKey` 和 `headers` 可以引用环境变量：`"apiKey": "${LOCAL_LLM_KEY}"`。

用内置 provider 的名字是修改它：改 `baseUrl` 走代理、追加模型，或用 `modelOverrides` 修改已有模型的上下文窗口和价格。

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://proxy.example.com/v1",
      "modelOverrides": { "<model-id>": { "contextWindow": 500000 } }
    }
  }
}
```

问题写进 Engine 日志：字段类型或结构写错时整个文件都不生效；结构正确但组不成 provider 时，只影响那一个 provider。`models.json` 在 Engine 启动和 `eevee model login` 时读取，其他时候修改后需要重启 Engine。全部字段见 [模型配置](models-configuration.md)。
