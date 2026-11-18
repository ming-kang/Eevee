# CHANGELOG

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

### Added

- 默认模型：`settings.json` 的 `models`（`default` 或按角色），项目可在 `project.json` 覆盖；`eevee model list / default / login`
- `models://` 列出默认模型、已登录 provider 的模型参数与 `models.md` 中的使用经验
- 后台作业：长命令自动转入后台（`job://jN`、`jobs/<id>.log`），结束后唤醒 Worker；重启打断时提醒 Worker 检查现场；结单时终止
- 并发槽位：`maxActiveWorkers` 限制同时运行的 Worker，超出的工单显示为“排队”
- 未处理的收尾报告超过 `reminderAfterMs` 后提醒 Router 一次
- 上下文超过 `handoffThreshold` 时，Worker 交收尾报告顺带重置，Router 空闲时被请求 `handoff`；Router 交接带上最近几轮原文
- Worker 观察与介入：查看执行对话、引导或排队发消息、打断（API 与 WebUI）
- 对话视图返回运行状态与失败原因，可以重试失败的一轮
- 基于 faux 模型的端到端测试
- 角色能力按扩展配置：各角色自带扩展，`settings.json` 的 `roles.<角色>.extensions` 启用更多、`maxTurns` 限制轮次；延迟加载的工具自动带上 `tool-search`，只给脚本用的工具自动带上 `codemode`；改动立即应用到 Router 与未结工单（`eevee role`、`/api/capabilities`）
- MCP：`~/.eevee/mcp.json`（`mcpServers` 格式，`exposure` 为 `deferred` / `direct` / `codemode` / `hidden`），每个服务器是扩展 `mcp.<名字>`，后台连接、断线后失去工具、`eevee mcp reload` 重连
- 用户扩展：`~/.eevee/extensions/` 下默认导出 Durable extension 的文件，装进每个项目，按角色启用
- `ticket model`：Router 中途给工单换模型
- 执行对话运行失败（重试用尽、超出轮次上限等）时引擎记一份 `failed` 报告并唤醒 Router
- Dreaming：按 `dreamIntervalMs`（默认 24 小时，0 关闭）定期开一张整理工单，列出有新发言的对话和新结的工单；`ready` 自动验收，改动提交为 `dreaming tN`
- 记忆历史：`eevee memory log / show / revert` 与对应 API；撤销冲突时放弃，不改动仓库
- 花费汇总：`eevee project usage` 与 `/api/projects/:project/usage`（合计、按模型、Router、每张工单）
- 实时流：`/api/stream` WebSocket，转发对话 watch 的值与 ops、推送看板变化、补齐记录缺口；token 走子协议
- `models.json`：新增或修改 provider、追加模型、`modelOverrides`，`apiKey` / `headers` 可引用环境变量；配错的 provider 只影响自己
- `read transcript://<对话>` 按条目分页，给出前后翻页的位置；`read` 文件时可带 `query` 搜索
- 面板改版：左栏项目列表（单一状态位、悬停卡片、可收起）、主区域对话、右栏“工单 / 作业 / 详情”标签，窄屏变抽屉；工具调用、调度、报告、文件改动、命令和作业通知折叠成一行；提问卡片支持推荐理由、“其他…”、翻页和“稍后”；命令面板（`Ctrl K`）；面板里新建项目，查看和管理记忆、花费、模型、角色能力与 MCP；深色模式；键盘操作与读屏支持
- `GET /api/projects/:project/jobs/:job/log` 读取后台作业的日志尾部，`POST /api/projects/:project/jobs/:job/kill` 终止单个作业，所属 Worker 会收到作业已终止的通知
- `GET /api/projects/:project/memory/:scope/files` 与 `…/files/:file`：列出和读取记忆文件
- 项目摘要带 `activeAt`（最近活动时间），看板带 `router`（Router 是否在运行、上一轮的失败原因）
- 面板“设置 · 通用”：主题、字体（字体名，排在自带字体前）与字号（12 到 20，文字和图标一起缩放），应用挂载前即生效
- 思考档位：模型选择可以带 `thinkingLevel`（`off` 到 `max`，不设为 `off`），`settings.json`、`project.json`、建单和 `ticket model` 都能指定；`eevee model default --thinking`；`/api/models` 列出每个模型支持的档位
- 面板语言：“设置 · 通用”可选简体中文或 English，默认跟随浏览器语言；产品和技术名词在中文里保留英文
- 面板输入框左下角选择这个项目 Router 的模型和思考档位（`POST /api/projects/:project/models`，写进 `project.json`）；设置里每个角色的默认模型旁边可选档位
- `npm run dev:scenario`：用 faux 模型启动带模拟数据的 Engine，供面板开发使用；造完数据后每次回答前停顿 5 秒，便于查看和操作运行中的状态

### Changed

- 面板改用实时流接收对话和看板，不再轮询；断线时左栏提示并自动重连
- 面板重做视觉与动效：层次靠明度和阴影而不是描边，圆角、控件高度、字号和动效时长各取几档；随面板打包 Inter 与 JetBrains Mono；分段控件只有一块滑动的底板，浮层上浮出现，正在进行的一行有流光扫过；首帧即用正确的主题；底色为中性灰（深色带一丝冷调），强调色浅色为蓝、深色为浅青色，深色文字亮度设上限、左栏的行再低一档；焦点环只在键盘操作时出现
- 面板字号与图标放大一档：列表的行、标题、输入框和菜单项改用 14，次要信息至少 12，图标随之放大
- 面板“花费”页改名为“用量”，第一格为“费用”
- 面板加载时用灰色骨架占位，代替“正在加载…”；加载很快时什么也不显示
- 面板去掉说明文字和副标题：左栏顶部改为“新建项目”“搜索”，底部的记忆 / 用量 / 设置改为图标；新建项目对话框不再显示等价命令；连接页只写状态，要运行的命令只出现在命令框里；还没有对话的项目把输入框放在页面中央
- 面板显示还没送达的消息（“待送达”）和模型开始输出前的“思考中”；作业日志停在最新一行，去掉多余的“刷新”按钮；Worker 对话里不再给每条消息标“直接介入”
- `GET /api/models` 返回结构化的模型视图（默认模型、Router 实际使用的模型、provider 凭据状态、可用模型），原来的文本仍在 `catalog` 字段
- 建单时 `output`、模型与理由改为可选，缺省使用默认模型
- 用户消息以普通用户条目写入对话，不再显示为通知
- `settings.json` 读写都按结构校验，格式不对时指出字段
- 工单视图带上运行中的后台作业
- CLI 按命令组拆分

### Fixed

- 面板跳到别的页面（包括浏览器后退）时，命令面板和新建项目对话框留在原处不关
- 一个事件需要投递给多个对话时（验收后的 `deliverTo`、回答工单的问题）整次提交失败
- 建单与开篇消息不在同一个 commit 里
