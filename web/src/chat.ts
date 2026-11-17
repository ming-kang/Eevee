import type { ChatLine } from "@shared/api/contract.ts";

export type ChatBlock =
  | { kind: "message"; key: number; line: ChatLine }
  | { kind: "process"; key: number; lines: ChatLine[] };

const PROCESS_ROLES = new Set<ChatLine["role"]>(["tool", "reset"]);
const CALL_ONLY = /^(\[调用 [^\]]+\]\s*)+$/;

export function isProcess(line: ChatLine): boolean {
  return PROCESS_ROLES.has(line.role) || (line.role === "assistant" && CALL_ONLY.test(line.text));
}

export function toBlocks(lines: readonly ChatLine[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (!isProcess(line)) blocks.push({ kind: "message", key: line.id, line });
    else if (last?.kind === "process") last.lines.push(line);
    else blocks.push({ kind: "process", key: line.id, lines: [line] });
  }
  return blocks;
}
