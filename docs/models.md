# 选择模型

Eevee 在 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) 之上接入模型，可以使用它内置的 provider。内置 provider 只需要提供 API key，然后选一个默认模型；只有 Eevee 不认识的 provider 或端点才需要写 `models.json`。目前只支持 API key 认证，需要浏览器登录（OAuth）的订阅还不能使用。

## 选择接入方式

| 你有什么 | 推荐做法 |
|:-:|:-:|
| 内置 provider 的 API Key | 在面板的“设置 · 模型”里填写，或设置环境变量 |
| 其他本地或云端网关 | 在“设置 · 模型”里[添加 provider](#接入兼容端点)，或写进 `models.json` |


## 认证

在面板左栏底部打开“设置”，切到“模型”页。Provider 列表里，有可用凭据的 provider 带绿点和凭据类型；已经有 provider 配好凭据时，列表只显示配好的，点“显示全部”可以看到其余的。点一行打开这个 provider 的设置页，在“API Key”里粘贴 key 后按 `Enter` 或点“保存”，Engine 把它保存在 `~/.eevee/auth.json`，立即生效。

面板只写入凭据，不会读出或显示保存过的 key：已经保存过时，输入框提示“已保存，输入新的 Key 替换”，旁边的“移除”删掉 `auth.json` 里的这一项。凭据来自别处（比如环境变量）时，输入框下面写着来源。脚本可以调用 [`POST /api/auth/:provider`](http-api.md#模型) 和 `DELETE /api/auth/:provider` 做同样的事。

也可以不保存，在启动 Engine 的终端里设置 provider 的环境变量，比如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`。常见变量见 [环境变量](environment-variables.md#provider-凭据)。

同一个 provider 配置了多个凭据来源时，按这个顺序取第一个可用的：

1. 保存在 `auth.json` 里的凭据；
2. `models.json` 里该 provider 的 `apiKey`；
3. provider 的环境变量或云平台的默认凭据。

`auth.json` 以私有权限原子写入。不要把它放进同步盘或版本控制。

## 设置默认模型

“设置 · 模型”页顶部有四行：全局默认、Router、Worker、Dreamer。点一行右边的模型按钮，从已配置凭据的 provider 的模型里选一个。没有单独设置的角色跟随全局默认，按钮上显示“跟随默认 · <model>”。Dreaming 用一个轻量模型就够了。

同一页下方的“可用模型”列出所有已配置凭据的 provider 的模型及其上下文窗口、价格和缓存时长，“使用经验”显示你在 `models.md` 里记录的内容。

改动立即应用到全部项目的 Router 和没有指定模型的工单。

### 思考档位

支持推理的模型可以设思考档位，从低到高为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，不设为 `off`。档位跟着模型走，写在同一处：在“设置 · 模型”里，选中的模型支持推理时，模型按钮左边会多出一个档位按钮，只列出这个模型支持的档位。

`settings.json` 与 `project.json` 里写作 `"thinkingLevel": "high"`。模型不支持的档位由 provider 换成最接近的一档；`models://` 列出每个模型支持的档位。

### 项目的默认模型

在面板里，输入框左下角的按钮显示当前项目 Router 的模型和思考档位，点开可以换；选择写进这个项目的 `project.json`，选“默认”则回到全局设置。也可以直接编辑 `~/.eevee/projects/<project>/project.json`，加上 `models`，然后重启 Engine：

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

Router 用 `read models://` 查看可用模型和你记录的经验。格式与“设置 · 模型”里的目录相同，但默认模型一栏列出的是这个项目里每个角色实际使用的模型，已经合并了 `project.json` 的设置。

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

服务兼容 Eevee 已支持的 API 时，可以在面板里添加：在“设置 · 模型”的 Provider 一栏点“添加”，填写下面几项后点“添加”。

| 字段 | 说明 |
|:-:|:-:|
| ID | provider 的名字，模型写作 `<ID>/<模型 id>`。只能用字母、数字、`.`、`_` 和 `-`，以字母或数字开头，添加后不能改 |
| API 类型 | 端点使用的接口协议，比如 OpenAI 兼容的 `openai-completions` |
| Base URL | 端点地址。下面显示请求实际发往的地址；Base URL 和协议路径都带了 `/v1` 时会提醒 |
| API Key | 保存到 `auth.json`。不检查 key 的端点（比如 Ollama）填任意值，模型才会变为可用 |

“模型”一栏至少要有一个模型。点“从端点获取”，Engine 向端点请求模型列表（OpenAI 风格的 `<Base URL>/models`，或 Anthropic 的 `/v1/models`），用的是刚填的 key 或“高级”里的 `apiKey`，都没填时用这个 provider 已保存的凭据。在列表里勾选要用的模型，点“加入”，端点声明了的上下文窗口、最大输出、图片输入和推理也一起填上。端点不提供列表时，点“添加模型”手动填写：模型 ID 必填，上下文窗口和最大输出可以写成 `128k`、`1.5m` 或 `200,000`，价格是每百万 token 的美元数。

网关上的模型常常就是某个内置模型。展开一个模型，点“使用内置数据”，Engine 按模型 ID 在 pi-ai 自带的模型目录里找相近的：先列 ID 完全相同的，再列只差大小写、分隔符或厂商前缀（比如 `anthropic/`）的，最后是模糊匹配；同一组里和这个模型接口相同的排在前面。搜索框里可以换别的词。选中一个后逐项列出“当前 → 内置”，勾选要复制的字段再点“复制”：可以复制名称、推理、图片输入、上下文窗口、最大输出和价格，模型 ID 和接口保持不变。没填的字段预先勾上；价格不预先勾选，因为网关的价格往往和官方不同；内置模型按输入长度分档的价格不会复制。复制只改表单，保存后才写入。

“高级”里可以设置显示名称（只用于显示，留空时显示 ID）、请求头（值可以引用环境变量，比如 `$LOCAL_LLM_KEY`）、是否另以 `Authorization: Bearer` 发送 key，以及 `models.json` 里的 `apiKey`。

内置 provider 的设置页可以改 Base URL 走代理、追加模型（同样可以使用内置数据）和设置请求头；“恢复内置设置”删掉 `models.json` 里它的条目。自己添加的 provider 可以删除，它保存在 `auth.json` 里的 key 一起删掉。

面板保存时只改这一个 provider 的条目，Engine 先检查：字段不合法、组不成 provider，或者会去掉一个正被默认模型（全局或某个项目的）使用的模型时，不写入文件，在页面上说明原因。保存成功后立即生效，不需要重启 Engine。文件里没有的字段原样保留，比如 `modelOverrides`；整个文件会按标准 JSON 格式重新写出。

也可以直接编辑 `~/.eevee/models.json`，新增一个 provider：

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

需要认证的端点，`apiKey` 和 `headers` 可以引用环境变量：`"apiKey": "${LOCAL_LLM_KEY}"`。

用内置 provider 的名字是修改它：改 `baseUrl` 走代理、追加模型，或用 `modelOverrides` 修改已有模型的上下文窗口和价格（面板不编辑 `modelOverrides`）。

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

问题写进 Engine 日志，也显示在“设置 · 模型”页：字段类型或结构写错时整个文件都不生效；结构正确但组不成 provider 时，只影响那一个 provider。`models.json` 在 Engine 启动、保存或移除 API Key、在面板里保存 provider 时读取，其他时候手动修改后需要重启 Engine。全部字段见 [模型配置](models-configuration.md)。
