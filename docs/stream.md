# 实时流

实时流是 Engine 在 `/api/stream` 上提供的 WebSocket 接口，用来实时接收对话和看板的变化。一个客户端只需要一条连接，在上面同时订阅任意多个对话和看板。协议的类型定义在 `src/api/stream.ts`。

## 连接

```js
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, ["eevee.v1", `token.${token}`]);
```

- 子协议必须包含 `eevee.v1`，以及 `token.` 加上 CLI token 或浏览器会话 token。浏览器无法给 WebSocket 设置请求头，所以 token 放在子协议里。
- Engine 只回应 `eevee.v1`，不会回显 token。
- 和 HTTP 接口一样，`Host` 和 `Origin` 必须是回环地址。

握手被拒绝时，Engine 直接返回 HTTP 状态并关闭连接：

| 状态 | 原因 |
|---|---|
| `400` | 子协议里没有 `eevee.v1` |
| `401` | token 缺失或无效 |
| `403` | 不是回环地址 |
| `404` | 路径不是 `/api/stream` |

连接建立后，Engine 先发送：

```json
{ "type": "hello", "bootId": "8f0c…" }
```

## 消息格式

每条 WebSocket 消息是一个 JSON 对象。客户端发送的单条消息最大 64 KB，超过时连接会被关闭。客户端给每个订阅或请求起一个 `id`，Engine 的回应带上同一个 `id`。

### 客户端发送

| `type` | 字段 | 作用 |
|---|---|---|
| `watch` | `id`、`topic`、可选 `window` | 订阅一个对话或看板 |
| `unwatch` | `id` | 取消订阅 |
| `entries` | `id`、`topic`、`query`、`limit` | 读取一段对话条目，用于补齐缺口 |

`topic` 有三种写法：

| `topic` | 含义 |
|---|---|
| `{ "kind": "conversation", "project": "p3f9a1c2e" }` | Router 的对话 |
| `{ "kind": "conversation", "project": "p3f9a1c2e", "ticket": "t3" }` | 工单 `t3` 的 Worker 对话 |
| `{ "kind": "board", "project": "p3f9a1c2e" }` | 项目的看板 |

同一条连接上的订阅 `id` 不能重复。

### Engine 发送

| `type` | 字段 | 含义 |
|---|---|---|
| `hello` | `bootId` | 连接建立 |
| `value` | `id`、`value` | 对话订阅的第一个值 |
| `ops` | `id`、`ops` | 把上一个值变成下一个值的增量操作 |
| `board` | `id`、`board` | 看板变化后的完整看板 |
| `entries` | `id`、`items` | `entries` 请求的结果 |
| `end` | `id`、`reason` | 订阅自行结束：`ended`（来源已关闭）、`failed` 或 `listener_error` |
| `error` | 可选 `id`、`code`、`message` | 请求失败；`code` 为 `not_found` 或 `error` |

## 订阅对话

```json
{ "type": "watch", "id": "w1", "topic": { "kind": "conversation", "project": "p3f9a1c2e", "ticket": "t3" } }
```

对话订阅原样转发 Pi Durable 的对话观察（watch）：先发一个 `value`，之后每次变化发一个 `ops`。`value`、`ops`、`window` 的格式，以及怎样应用增量、拼出完整记录，见 [Pi Durable 的文档](https://github.com/earendil-works/pi/tree/main/packages/durable) 中观察对话的部分。

慢客户端不会拖住 Engine，也不会丢失状态：连接的发送缓冲超过 1 MB 时，Engine 暂停发送对话的增量，降到 1 MB 以下后再发，期间的变化合并成一批。

### 补齐缺口

`entries` 请求读取一段对话条目，用来补齐断线或积压造成的缺口、加载更早的记录：

```json
{
  "type": "entries",
  "id": "e1",
  "topic": { "kind": "conversation", "project": "p3f9a1c2e" },
  "query": { "minEntryId": 120, "maxEntryId": 180, "order": "ascending" },
  "limit": 50
}
```

`query` 是 Durable 的条目查询，不含对话编号；`limit` 最大 200，超出时按 200 处理。

## 订阅看板

```json
{ "type": "watch", "id": "b1", "topic": { "kind": "board", "project": "p3f9a1c2e" } }
```

Engine 立即发送一次完整看板，之后每当看板有变化，就再发一次完整看板。看板的格式与 [`GET /api/projects/:project/board`](http-api.md#项目) 相同。Engine 约每 500 毫秒检查一次变化。

## 断线重连

1. 重新连接，等待 `hello`。
2. 如果 `bootId` 和之前不同，说明 Engine 重启过：丢弃全部旧状态，像第一次连接一样重新订阅。
3. 如果 `bootId` 相同，按 Durable 文档的续传方式，带上 `window` 重新订阅每个对话，再用 `entries` 补齐中间的缺口。看板直接重新订阅即可。

## 保活

Engine 每 30 秒发送一次 WebSocket ping。客户端在下一次 ping 之前没有回应 pong 时，连接会被关闭。浏览器和常见的 WebSocket 库会自动回应 ping。

连接关闭时，这条连接上的全部订阅随之取消。
