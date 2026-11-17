# 接入本地接口

命令行和面板都通过 Engine 的本地接口工作。你也可以用同样的接口写脚本或自己的客户端：发请求用 HTTP 接口，接收实时更新用 WebSocket 实时流。

## 选择方式

| 需要 | 使用 |
|:-:|:-:|
| 在 shell 脚本里管理项目、模型和记忆 | [命令行](cli.md) |
| 从其他程序发消息、回答问题、读取看板 | [HTTP 接口](http-api.md) |
| 实时显示对话和看板的变化 | [实时流](stream.md) |

## 找到 Engine

Engine 把实际端口写在 `<数据目录>/runtime/engine.json` 里：

```json
{ "pid": 41236, "port": 19190, "bootId": "8f0c…", "startedAt": 1763366400000 }
```

默认端口 `19190` 被占用时，Engine 会换一个空闲端口，所以客户端应当读这个文件，而不是写死端口。`GET /api/health` 不需要鉴权，可以用来确认 Engine 在运行。

## 鉴权

除了健康检查和授权码兑换，所有请求都要在 `x-eevee-token` 请求头里带 token。有两种 token：

| token | 从哪里来 | 能做什么 |
|:-:|---|:-:|
| CLI token | `<数据目录>/runtime/cli-token` 文件 | 全部接口 |
| 会话 token | 用 `eevee web` 的一次性授权码换取 | 除停止 Engine、生成授权码、保存凭据以外的接口 |

本机脚本直接读 CLI token 即可。浏览器类客户端应当走授权码流程：CLI 调用 `POST /api/session/code` 生成授权码，客户端用 `POST /api/session` 把它换成会话 token。授权码 90 秒内有效、只能用一次；会话 12 小时无操作后过期。

请求必须发往回环地址，`Host` 和 `Origin` 请求头（如果有）也必须是回环地址，否则返回 `403`。

## 发一个请求

```bash
TOKEN=$(cat ~/.eevee/runtime/cli-token)
PORT=$(node -p 'require(require("os").homedir() + "/.eevee/runtime/engine.json").port')

curl -s -H "x-eevee-token: $TOKEN" "http://127.0.0.1:$PORT/api/status"

curl -s -X POST -H "x-eevee-token: $TOKEN" -H "content-type: application/json" \
  -d '{"text":"把今天的实验结果整理成周报"}' \
  "http://127.0.0.1:$PORT/api/projects/p3f9a1c2e/messages"
```

成功时返回 JSON；失败时返回对应的 HTTP 状态码和 `{"error":{"code":"…","message":"…"}}`，错误码见 [HTTP 接口](http-api.md#错误)。

在本仓库里写 TypeScript 时，可以用 `src/api/client.ts` 的 `createClient`，它按 `src/api/contract.ts` 推导每个接口的参数和返回类型：

```ts
import { createClient } from "./src/api/client.ts";

const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token });
const board = await client.call("GET /api/projects/:project/board", { project: "p3f9a1c2e" });
```

## 订阅实时更新

一个客户端开一条 WebSocket 连接到 `/api/stream`，在上面同时订阅任意多个对话和看板。浏览器无法给 WebSocket 设置请求头，所以 token 放在子协议里：

```js
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, ["eevee.v1", `token.${token}`]);

ws.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === "hello") {
    ws.send(JSON.stringify({ type: "watch", id: "board", topic: { kind: "board", project: "p3f9a1c2e" } }));
    ws.send(JSON.stringify({ type: "watch", id: "router", topic: { kind: "conversation", project: "p3f9a1c2e" } }));
  }
  if (event.type === "board") render(event.board);
};
```

对话订阅先发一次完整的结构视图，之后只发把上一个值变成下一个值的增量操作。完整协议、断线重连和补齐缺口的方法见 [实时流](stream.md)。

## 处理 Engine 重启

`GET /api/status` 和实时流的第一个事件 `hello` 都带有 `bootId`，Engine 每次启动都会生成新的值。客户端重连后发现 `bootId` 变了，应当丢弃旧状态、重新订阅全部数据，而不是把新进程的增量拼到旧进程的状态上。
