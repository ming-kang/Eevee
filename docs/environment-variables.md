# 环境变量

这一页列出 Eevee 读取的环境变量，以及 Engine 传给子进程的环境变量。

`eevee` 和 `eevee start` 启动 Engine 时，把运行它的终端的环境变量原样传给 Engine。所以 provider 凭据和 `models.json`、`mcp.json` 里引用的变量，都要在启动 Engine 的环境里设置；修改后需要重启 Engine。

## Eevee

| 变量 | 说明 |
|---|---|
| `EEVEE_HOME` | 数据目录，默认 `~/.eevee`。命令行和 Engine 都按它找配置、数据和运行时文件；不同的值对应互不相干的实例 |

开发和测试时用一个临时目录作为 `EEVEE_HOME`，可以不碰日常使用的数据，见 [参与开发](development.md#隔离数据)。

## Provider 凭据

内置 provider 没有保存凭据时，从环境变量读取 API key。常见的有：

| Provider | 变量 |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN` |
| `openai` | `OPENAI_API_KEY` |
| `azure` | `AZURE_OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`，或 gcloud 的默认凭据 |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `moonshotai` | `MOONSHOT_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |

完整列表以 `@earendil-works/pi-ai` 为准。面板里保存的凭据（`auth.json`）和 `models.json` 里的 `apiKey` 优先于环境变量，见 [选择模型](models.md#认证)。

## 配置文件中的引用

下列配置值可以用 `$NAME` 或 `${NAME}` 引用 Engine 的环境变量：

| 文件 | 字段 |
|---|---|
| `models.json` | provider 的 `apiKey`、`headers` |
| `mcp.json` | 服务器的 `env`、`headers` |

见 [模型配置](models-configuration.md#引用环境变量) 和 [接入 MCP 服务器](mcp.md#引用环境变量)。

## 子进程继承的变量

Worker 的 `bash` 命令、后台作业和 stdio MCP 服务器不继承 Engine 的全部环境变量，只继承下列变量中已经设置的那些：

```text
PATH  Path  PATHEXT  HOME  USERPROFILE  HOMEDRIVE  HOMEPATH  APPDATA  LOCALAPPDATA
SystemRoot  SystemDrive  windir  ComSpec  TEMP  TMP  TMPDIR
LANG  LC_ALL  TERM  SHELL  USER  USERNAME
```

provider 的 API key 等其他变量不会传给它们。MCP 服务器需要的变量在 `mcp.json` 的 `env` 里显式写明；Worker 的命令需要的变量，可以让它在命令里设置，或写进工作目录里的配置文件。

这只用来减少意外泄漏，不是隔离边界，见 [安全运行](security.md#子进程的环境变量)。
