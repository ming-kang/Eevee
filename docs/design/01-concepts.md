# 概念

## 1. 核心概念

| 概念 | 代码名 | 定义 |
|:-:|:-:|---|
| 项目 | `Project` | 一个持续工作的项目：一个 Router、一组工单、记忆库和持久对话状态 |
| 调度者 | `Router` | 项目的根对话与用户的主要入口，负责全局规划、工单协调、报告处理和长期记忆 |
| 工单 | `Ticket` | 一项独立工作的协调外壳，与一个持续的 Worker 主对话一一对应 |
| 执行者 | `Worker` | 工单对应的会话，负责执行任务；用户可以发送引导消息 |
| 报告 | `Report` | Worker 与 Router 之间的自动协同结果，分为中途报告与收尾报告 |
| 记忆库 | `MemoryDrive` | 基于 Git 的 Markdown 笔记仓库，分项目级和全局两份 |

## 2. 支撑概念

这些概念服务于核心模型：

| 概念 | 代码名 | 作用 |
|:-:|:-:|---|
| 提问 | `Question` | 需要用户决定时的一组结构化问题 |
| 轮次 | run | 对话从收到一条消息开始，到最终回答、被打断或失败为止的一次连续运行 |
| 后台作业 | `Job` | Worker 的长时命令或其他后台执行，完成后可以唤醒所属 Worker |
| 角色 | `Role` | 一类对话的提示词、Opening 与 Extension 能力配置 |
| 开篇 | `Opening` | 对话创建或 `reset` 时生成的开场材料，具体组成属于实现策略 |
| 资源地址 | URI | 引用持久对象的统一写法，如 `ticket://t12`、`report://t12#3` |
| 工作目录 | `Workspace` | 用户自己的项目目录，产物默认写在这里 |
| 模型画像 | `ModelProfile` | 模型客观参数与用户记录的使用经验，供需要时选择模型 |
| 引擎 | `Engine` | 常驻后台的 Node.js 进程，承载全部项目与本地 WebUI |

系统内部还有 `dreamer` 执行配置，用于记忆整理工单；具体职责与 Extension 配置见 [02 角色与能力](02-roles.md)。

## 3. 逻辑数据模型

核心字段如下（省略时间戳等元数据）：

```ts
type Ticket = {
  id: TicketId;               // t1, t2, …
  title: string;
  goal: string;
  inputs: string[];           // 文件路径或资源地址
  acceptance: string[];       // 验收标准
  output?: string;            // 产物位置
  deliverTo: TicketId[];      // 验收后把结果投给这些工单
  model?: ModelChoice;        // 缺省用角色默认模型
  conversationId: number;     // 对应的 Worker 对话
  status: "open" | "done" | "cancelled";
  closeNote?: string;         // 验收证据或取消原因
};

type Report = {
  ticketId: TicketId;
  seq: number;                // 工单内递增，report://t12#3
  status: "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";
  summary: string;            // 投给 Router 的摘要
  detail?: string;            // 完整内容，按需 read
  artifacts: { path: string; note: string }[];
  need?: string;              // waiting 时缺什么
  questions?: QuestionItem[]; // 要用户决定的问题
  lessons?: string[];         // 值得记住的经验
  handled: boolean;           // Router 是否已处理
};

type Question = {
  id: QuestionId;             // q1, q2, …
  ticketId?: TicketId;        // 缺省属于 Router
  items: QuestionItem[];      // { text, options, recommended? }
  answer?: string;
};
```

这些状态存在项目的 `session.sqlite` 里：`Board`（编号分配、工单列表、未回答的问题）是 session 级文档；工单、报告记录、问题按编号存成文档族；每个 Worker 对话另有一份绑定文档，记录它属于哪张工单。

工单只存三种状态；界面上的“工作中 / 待验收 / 受阻”等阶段由最新报告和运行情况推导，不另外存储（见 [03 工单与调度](03-orchestration.md)）。报告状态只是协同词汇，不为每种状态再建立一套独立工作流。

## 4. 数据归属

每类信息只有一个主要归属。

| 存储 | 内容 | 来源 |
|:-:|---|:-:|
| `session.sqlite` | 全部对话记录；工单、报告、问题文档 | 引擎 |
| 记忆库 | 偏好、纠正、带理由的决策、踩过的坑 | Router 的 `memory` 工具、Dreaming、用户手改 |
| 工作目录 | 用户的项目文件和全部产物 | Worker、用户 |
| `~/.eevee/` 配置文件 | 凭据、模型配置、模型画像、角色能力配置 | 引擎、用户 |

由此得到三条边界：

- **任务进度**只在工单和报告里，不写进记忆。
- **对话上下文**可以压缩或重置，持久对话记录与业务状态不因此丢失。
- **记忆**只记跨任务长期有用的经验，随时能从文件里查到的事实不记。
