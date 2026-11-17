import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { Board, JobDoc, ReportLog, TicketDoc } from "../../contracts/docs.ts";
import {
  type Address,
  AddressError,
  formatAddress,
  type Job,
  type MemoryScope,
  parseAddress,
  type TicketId,
} from "../../contracts/index.ts";
import { readText } from "../../shared/fs.ts";
import { resolveInside } from "../../shared/paths.ts";
import { continuation, pageList, pageText } from "./paging.ts";

export const READ_TOOL = "read";

export type ResourceDeps = {
  memoryDir(scope: MemoryScope): string;
  jobLog(id: string): string;
  models(context: Context): Promise<string>;
  transcript(
    conversationId: number,
    entryId: number | undefined,
    context: Context,
  ): Promise<string | undefined>;
};

const Parameters = obj({
  path: str({
    description: "文件路径或资源地址，如 ticket://t3、report://t3#2、memory://project/MEMORY.md",
  }),
  offset: opt(int({ minimum: 0, description: "从哪里开始读（文件为行号，其余为字符或条目）" })),
  limit: opt(int({ minimum: 1, description: "读多少" })),
  query: opt(str({ description: "只返回包含该文本的行" })),
});

export function createResources(deps: ResourceDeps) {
  const fileRead = createReadTool();

  const read = defineTool({
    name: READ_TOOL,
    description:
      "按地址读取：文件路径，或 ticket:// report:// transcript:// memory:// job:// models://。一律分页。",
    parameters: Parameters,
    replay: "safe",
    async execute(args, api, context) {
      let address: Address;
      try {
        address = parseAddress(args.path);
      } catch (error) {
        if (error instanceof AddressError) return text(error.message, true);
        throw error;
      }
      if (address.kind === "file") {
        return fileRead.execute(
          {
            path: address.path,
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          },
          api,
          context,
        );
      }
      if (address.kind === "tickets") return listTickets(api, args.offset, args.limit, context);

      const body = await resolve(deps, address, api, context);
      if (body === undefined) return text(`没有找到 ${args.path}`, true);
      const filtered = args.query === undefined ? body : grep(body, args.query);
      const page = pageText(filtered, args.offset, args.limit);
      return text(page.text + continuation(formatAddress(address), page));
    },
  });

  return defineExtension({ name: "eevee.resources", tools: [read] });
}

async function resolve(
  deps: ResourceDeps,
  address: Exclude<Address, { kind: "file" } | { kind: "tickets" }>,
  api: ToolExecutionApi,
  context: Context,
): Promise<string | undefined> {
  switch (address.kind) {
    case "ticket": {
      const ticket = await api.snapshot(TicketDoc, address.id, context);
      return ticket && JSON.stringify(ticket, null, 2);
    }
    case "report": {
      const reports = (await api.snapshot(ReportLog, address.ticketId, context))?.reports ?? [];
      const selected =
        address.seq === undefined ? reports : reports.filter((r) => r.seq === address.seq);
      return selected.length === 0 ? undefined : JSON.stringify(selected, null, 2);
    }
    case "memory":
      return readText(resolveInside(deps.memoryDir(address.scope), address.file));
    case "job": {
      const job = await api.snapshot(JobDoc, address.id, context);
      const log = await readText(deps.jobLog(address.id));
      if (job === undefined && log === undefined) return undefined;
      const status = job === undefined ? "" : `${describeJob(job)}\n\n`;
      return status + (log ?? "（还没有输出）");
    }
    case "models":
      return deps.models(context);
    case "transcript":
      return deps.transcript(address.conversationId, address.entryId, context);
  }
}

async function listTickets(
  api: ToolExecutionApi,
  offset: number | undefined,
  limit: number | undefined,
  context: Context,
) {
  const ids = [...((await api.snapshot(Board, context))?.tickets ?? [])].reverse();
  const page = pageList(ids, offset, limit);
  const lines: string[] = [];
  for (const id of page.items as TicketId[]) {
    const ticket = await api.snapshot(TicketDoc, id, context);
    if (ticket) lines.push(`${ticket.id} [${ticket.status}] ${ticket.title}`);
  }
  return text((lines.join("\n") || "还没有工单。") + continuation("ticket://", page));
}

function describeJob(job: Job): string {
  const parts = [`${job.id} · ${job.ticketId} · ${job.status}`];
  if (job.exitCode !== undefined) parts.push(`退出码 ${job.exitCode}`);
  if (job.error !== undefined) parts.push(job.error);
  return parts.join(" · ");
}

function grep(body: string, query: string): string {
  return body
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.includes(query))
    .map(([n, line]) => `${n}: ${line}`)
    .join("\n");
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});
