import { MEMORY_EXTENSION } from "../extensions/memory/index.ts";
import { DISPATCH_EXTENSION } from "../extensions/orchestration/index.ts";
import { RESOURCES_EXTENSION } from "../extensions/resources/index.ts";
import { block, compose, memoryBlocks } from "./opening.ts";
import { defineRole } from "./role.ts";

export const HANDOFF_TOOL = "handoff";
/** The Router's own tool, `handoff`, which needs the Router's opening. */
export const ROUTER_EXTENSION = "eevee.router";

export type RouterSubject = {
  project: { title: string; workspace: string };
  tickets: string[];
  summary?: string;
  recent?: string;
};

const instructions = `你是 Eevee 的调度者（Router），是用户唯一的对话对象。

你只分派、不干活：需要读写工作目录、运行命令的事，用 ticket 建工单交给执行对话去做。
- 需求清楚就直接建单；不清楚时先用 read 查工作目录和记忆，只有真要用户拍板的分歧才用 ask_user，每题附推荐答案。
- 建单时写清目标、输入、验收标准，有明确产物位置时写上。默认模型够用就不必指定；确有需要再选模型和思考档位并说明理由（可用模型、画像与支持的档位见 models://），做到一半需要换模型时用 ticket model。一张工单的结果要交给另一张时，用 deliverTo。
- 收到 ready 报告后，对照验收标准检查，用 review 处理：accept 必须附证据，rework 写明缺什么。
- 执行对话的疑问，能回答就用 ticket message 回答，否则带上 ticketId 用 ask_user 问用户。
- 有长期价值的偏好、纠正、带理由的决策、踩过的坑，用 memory 记下；任务进度不记。
- 上下文变得杂乱时，用 handoff 写一段交接小结，重新开始。

占用尽量少的用户注意力：只在需要用户决定、或有成果可验收时才开口，干活时保持安静。
消息里出现的地址（ticket:// report:// transcript:// memory:// job://）都可以用 read 展开。`;

export const routerRole = defineRole<RouterSubject>({
  name: "router",
  instructions,
  extensions: [RESOURCES_EXTENSION, DISPATCH_EXTENSION, MEMORY_EXTENSION, ROUTER_EXTENSION],
  opening: (subject, memory) =>
    compose(
      ...memoryBlocks(memory),
      block("project", `${subject.project.title}\n工作目录：${subject.project.workspace}`),
      block("tickets", subject.tickets.join("\n") || "还没有工单。"),
      block("handoff-summary", subject.summary),
      block("recent", subject.recent),
    ),
});
