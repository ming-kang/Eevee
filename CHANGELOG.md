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

### Changed

- 建单时 `output`、模型与理由改为可选，缺省使用默认模型
- 用户消息以普通用户条目写入对话，不再显示为通知

### Fixed

- 一个事件需要投递给多个对话时（验收后的 `deliverTo`、回答工单的问题）整次提交失败
- 建单与开篇消息不在同一个 commit 里
