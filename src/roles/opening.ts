import { formatAddress, type Report, type Ticket } from "../contracts/index.ts";
import type { MemorySnapshot } from "./role.ts";

export function block(title: string, body: string | undefined): string | undefined {
  const trimmed = body?.trim();
  return trimmed ? `<${title}>\n${trimmed}\n</${title}>` : undefined;
}

export function compose(...blocks: (string | undefined)[]): string {
  return blocks.filter((b) => b !== undefined).join("\n\n");
}

export function memoryBlocks(memory: MemorySnapshot): string[] {
  return [block("global-memory", memory.global), block("project-memory", memory.project)].filter(
    (b) => b !== undefined,
  );
}

export function renderTicket(ticket: Ticket): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  return compose(
    `${ticket.id}「${ticket.title}」 ${formatAddress({ kind: "ticket", id: ticket.id })}`,
    `目标：${ticket.goal}`,
    ticket.inputs.length ? `输入：\n${list(ticket.inputs)}` : undefined,
    `验收标准：\n${list(ticket.acceptance)}`,
    ticket.output ? `产物写到：${ticket.output}` : undefined,
  );
}

export function renderLatestReport(report: Report | undefined): string | undefined {
  if (report === undefined) return undefined;
  return compose(
    `${formatAddress({ kind: "report", ticketId: report.ticketId, seq: report.seq })} · ${report.status}`,
    report.summary,
    report.need ? `缺：${report.need}` : undefined,
  );
}
