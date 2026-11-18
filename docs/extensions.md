# 编写扩展

Eevee 的扩展就是 Pi Durable 扩展，可以提供工具、系统提示词段落、Hooks 与后台任务；扩展写法参见 [Pi Durable 的文档](https://github.com/earendil-works/pi/tree/main/packages/durable)。

放进 `~/.eevee/extensions/` 的扩展适用于所有项目，可以为角色启用。扩展在 Engine 进程里运行，拥有 Engine 的全部权限。

## 快速开始

1. 在 `~/.eevee/extensions/` 里新建 `clock.ts`：

   ```ts
   import type { Extension } from "@earendil-works/pi-durable";

   const extension: Extension = {
     name: "clock",
     tools: [
       {
         name: "now",
         description: "返回当前时间（ISO 8601）",
         parameters: { type: "object", properties: {}, additionalProperties: false },
         async execute() {
           return { output: [{ type: "text", text: new Date().toISOString() }] };
         },
       },
     ],
   };

   export default extension;
   ```

2. 在同一目录放一个 `package.json`，声明这里是 ES 模块，避免 Node 的模块类型警告：

   ```json
   { "type": "module" }
   ```

3. 重启 Engine，然后在面板的“设置 · MCP 与扩展”里确认它已加载，再在“角色能力”页为 Worker 打开 `clock` 的开关：

   ```bash
   eevee stop && eevee start
   ```

Node.js 26 直接运行 `.ts` 文件，无需编译。Node 只是去掉类型标注，所以 `enum`、`namespace`、构造函数参数属性这类需要编译的 TypeScript 语法不能使用。

## 位置与加载

| 规则 | 说明 |
|---|---|
| 位置 | `~/.eevee/extensions/` 目录下的文件，不进入子目录 |
| 文件类型 | `.ts`、`.js`、`.mjs`；`.d.ts` 会被忽略 |
| 默认导出 | 一个扩展对象，或者返回扩展的函数（可以是 async 函数） |
| 加载时机 | Engine 启动时加载一次；修改后需要重启 Engine |
| 加载失败 | 只影响这一个文件；错误显示在“设置 · MCP 与扩展”里，也写进 Engine 日志 |

一个文件只提供一个扩展。需要多个文件组织代码时，把辅助模块放进子目录，再从顶层文件导入。

### 命名

扩展名就是角色启用它时写的名字：

- 每个扩展的 `name` 必须唯一，重名的后一个文件会加载失败；
- `eevee.*`、`mcp.*`、`tool-search`、`codemode` 等是 Eevee 保留的名字。

工具名在一个对话选中的全部工具里也应当唯一，建议给工具加上扩展相关的前缀。

## 依赖

只用 `import type` 引用类型时，导入语句在运行时会被去掉，扩展目录里不需要安装任何依赖。

需要从 `@earendil-works/pi-durable` 或其他 Pi 包导入运行时函数时，在扩展目录里安装与 Eevee 相同的版本（当前为 `1.5.2`）：

```bash
cd ~/.eevee/extensions
npm install @earendil-works/pi-durable@1.5.2
```

Eevee 升级这些包时，扩展目录里的版本也要跟着升级。

## 启用与调试

- 在“设置 · 角色能力”里启用，见 [配置角色能力](capabilities.md)；那里也列出每个扩展的工具数。
- 在“设置 · MCP 与扩展”里查看加载结果。加载失败的原因（语法错误、默认导出不对、重名、保留名）显示在对应文件那一行。
- 扩展里 `console.log` 的输出写进 Engine 日志 `~/.eevee/runtime/engine.log`。
- 修改扩展后重启 Engine。已经启用它的角色不需要重新启用。
- 扩展提供的提示词段落不要包含当前时间这类会变的内容，否则这个角色的缓存前缀每次请求都会失效。
