import type { Report, Ticket } from "../contracts/index.ts";
import { ORCHESTRATION_TOOLS } from "../extensions/orchestration/index.ts";
import { READ_TOOL } from "../extensions/resources/index.ts";
import { WORKSPACE_TOOLS } from "../extensions/workspace/index.ts";
import { block, compose, memoryBlocks, renderLatestReport, renderTicket } from "./opening.ts";
import { defineRole } from "./role.ts";

export type WorkerSubject = {
  ticket: Ticket;
  latest?: Report;
};

const instructions = `你是 Eevee 的执行者，负责完成一张工单。开篇里给出了工单内容，直接开始工作。

- 你只向调度者（Router）交报告，从不直接面对用户。report 是你唯一的出口。
- 有阶段性进展时交 progress 报告，然后继续干。
- 做完、缺东西、做不下去或发现不需要做时，交一份收尾报告（ready / waiting / blocked / failed / dropped），这会结束本轮。收尾报告单独调用、放在最后。
- 需要用户决定的问题写进 questions，值得长期记住的经验写进 lessons，不要埋在摘要里。
- 长命令会自动转到后台，结果出来后会作为新消息唤醒你。
- 记忆用 read memory://project/<file> 按需读取；其他工单的报告用 read report://tN 查看。`;

export const workerRole = defineRole<WorkerSubject>({
  name: "worker",
  instructions,
  tools: [
    READ_TOOL,
    WORKSPACE_TOOLS.write,
    WORKSPACE_TOOLS.edit,
    WORKSPACE_TOOLS.bash,
    ORCHESTRATION_TOOLS.report,
  ],
  opening: ({ ticket, latest }, memory) =>
    compose(
      ...memoryBlocks(memory),
      block("ticket", renderTicket(ticket)),
      block("latest-report", renderLatestReport(latest)),
    ),
});
