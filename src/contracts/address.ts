import type { JobId, TicketId } from "./domain.ts";

export type MemoryScope = "project" | "global";

export type Address =
  | { kind: "file"; path: string }
  | { kind: "tickets" }
  | { kind: "ticket"; id: TicketId }
  | { kind: "report"; ticketId: TicketId; seq?: number }
  | { kind: "transcript"; conversationId: number; entryId?: number }
  | { kind: "memory"; scope: MemoryScope; file: string }
  | { kind: "job"; id: JobId }
  | { kind: "models" };

const SCHEME = /^([a-z]+):\/\/(.*)$/;
const TICKET = /^t[1-9]\d*$/;
const JOB = /^j[1-9]\d*$/;

export class AddressError extends Error {
  override name = "AddressError";
}

export function parseAddress(raw: string): Address {
  const match = SCHEME.exec(raw.trim());
  if (!match) return { kind: "file", path: raw };
  const scheme = match[1];
  const rest = match[2] ?? "";
  switch (scheme) {
    case "ticket":
      return rest === "" ? { kind: "tickets" } : { kind: "ticket", id: ticket(rest, raw) };
    case "report": {
      const [id = "", seq] = rest.split("#");
      return seq === undefined
        ? { kind: "report", ticketId: ticket(id, raw) }
        : { kind: "report", ticketId: ticket(id, raw), seq: positive(seq, raw) };
    }
    case "transcript": {
      const [conversation = "", entry] = rest.split("/");
      const conversationId = natural(conversation, raw);
      return entry === undefined
        ? { kind: "transcript", conversationId }
        : { kind: "transcript", conversationId, entryId: natural(entry, raw) };
    }
    case "memory": {
      const slash = rest.indexOf("/");
      const scope = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (slash < 0 || (scope !== "project" && scope !== "global") || file === "") {
        throw new AddressError(
          `记忆地址应为 memory://project/<file> 或 memory://global/MEMORY.md：${raw}`,
        );
      }
      return { kind: "memory", scope, file };
    }
    case "job":
      if (!JOB.test(rest)) throw new AddressError(`无效的作业编号：${raw}`);
      return { kind: "job", id: rest as JobId };
    case "models":
      return { kind: "models" };
    default:
      throw new AddressError(`未知的地址协议：${scheme}://`);
  }
}

export function formatAddress(address: Address): string {
  switch (address.kind) {
    case "file":
      return address.path;
    case "tickets":
      return "ticket://";
    case "ticket":
      return `ticket://${address.id}`;
    case "report":
      return address.seq === undefined
        ? `report://${address.ticketId}`
        : `report://${address.ticketId}#${address.seq}`;
    case "transcript":
      return address.entryId === undefined
        ? `transcript://${address.conversationId}`
        : `transcript://${address.conversationId}/${address.entryId}`;
    case "memory":
      return `memory://${address.scope}/${address.file}`;
    case "job":
      return `job://${address.id}`;
    case "models":
      return "models://";
  }
}

function ticket(value: string, raw: string): TicketId {
  if (!TICKET.test(value)) throw new AddressError(`无效的工单编号：${raw}`);
  return value as TicketId;
}

function natural(value: string, raw: string): number {
  if (!/^\d+$/.test(value)) throw new AddressError(`无效的对话或条目编号：${raw}`);
  return Number(value);
}

function positive(value: string, raw: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new AddressError(`无效的报告序号：${raw}`);
  return n;
}
