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
import { continuation, LIST_PAGE, pageList, pageText } from "./paging.ts";

export const READ_TOOL = "read";
export const RESOURCES_EXTENSION = "eevee.resources";

/** One transcript line as `read transcript://` shows it. */
export type TranscriptLine = { id: number; role: string; text: string };

/** A page of `limit` entries' lines; entries with nothing to show have no line. */
export type TranscriptPage = {
  lines: TranscriptLine[];
  /** Entries before the page exist (a page of the newest entries). */
  earlier?: boolean;
  /** Where the next page starts (a page read from an entry on). */
  next?: number;
};

export type TranscriptSource = {
  /** One entry's full text. */
  entry(conversationId: number, entryId: number, context: Context): Promise<string | undefined>;
  /** Entries from entry `from` on, or the newest ones without it; undefined for an unknown conversation. */
  page(
    conversationId: number,
    range: { from?: number; limit: number },
    context: Context,
  ): Promise<TranscriptPage | undefined>;
};

export type ResourceDeps = {
  memoryDir(scope: MemoryScope): string;
  jobLog(id: string): string;
  models(context: Context): Promise<string>;
  transcript: TranscriptSource;
};

const Parameters = obj({
  path: str({
    description: "文件路径或资源地址，如 ticket://t3、report://t3#2、memory://project/MEMORY.md",
  }),
  offset: opt(
    int({
      minimum: 0,
      description:
        "从哪里开始读：文件为行号，ticket:// 为第几项，transcript:// 为条目编号，其余为字符",
    }),
  ),
  limit: opt(int({ minimum: 1, description: "读多少" })),
  query: opt(str({ description: "只返回包含该文本的行，比如 ticket:// 加 [open] 只看未结的工单" })),
});

/** The one `read` every role shares: files and every resource address, always paged. */
export function createResources(deps: ResourceDeps) {
  const fileRead = createReadTool();

  const read = defineTool({
    name: READ_TOOL,
    description:
      "按地址读取：文件路径，或 ticket:// report:// transcript:// memory:// job:// models://。一律分页。",
    parameters: Parameters,
    ...(fileRead.structuredOutputSchema === undefined
      ? {}
      : { structuredOutputSchema: fileRead.structuredOutputSchema }),
    replay: "safe",
    async execute(args, api, context) {
      let address: Address;
      try {
        address = parseAddress(args.path);
      } catch (error) {
        if (error instanceof AddressError) return text(error.message, true);
        throw error;
      }
      switch (address.kind) {
        case "file":
          if (args.query !== undefined) return searchFile(api, address.path, args, context);
          return fileRead.execute(
            {
              path: address.path,
              ...(args.offset === undefined ? {} : { offset: args.offset }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            },
            api,
            context,
          );
        case "tickets":
          return listTickets(api, args, context);
        case "transcript":
          if (address.entryId === undefined) {
            return readTranscript(deps.transcript, address.conversationId, args, context);
          }
          break;
      }

      const body = await resolve(deps, address, api, context);
      if (body === undefined) return text(`没有找到 ${args.path}`, true);
      const filtered = args.query === undefined ? body : grep(body, args.query);
      const page = pageText(filtered, args.offset, args.limit);
      return text(page.text + continuation(formatAddress(address), page));
    },
  });

  return defineExtension({ name: RESOURCES_EXTENSION, tools: [read] });
}

type Args = { offset?: number; limit?: number; query?: string };

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
      return address.entryId === undefined
        ? undefined
        : deps.transcript.entry(address.conversationId, address.entryId, context);
  }
}

async function searchFile(api: ToolExecutionApi, path: string, args: Args, context: Context) {
  const read = await api.env?.readTextFile(path, context);
  if (read === undefined) return text("没有执行环境，读不了文件", true);
  if (!read.ok) return text(`读不了 ${path}：${read.error.message}`, true);
  const page = pageText(grep(read.value, args.query ?? ""), args.offset, args.limit);
  return text((page.text || "没有匹配的行。") + continuation(path, page));
}

async function listTickets(api: ToolExecutionApi, args: Args, context: Context) {
  const ids = [...((await api.snapshot(Board, context))?.tickets ?? [])].reverse();
  const lines: string[] = [];
  for (const id of ids as TicketId[]) {
    const ticket = await api.snapshot(TicketDoc, id, context);
    if (ticket) lines.push(`${ticket.id} [${ticket.status}] ${ticket.title}`);
  }
  const matching =
    args.query === undefined ? lines : lines.filter((l) => l.includes(args.query ?? ""));
  const page = pageList(matching, args.offset, args.limit);
  const empty = lines.length === 0 ? "还没有工单。" : "没有匹配的工单。";
  return text((page.items.join("\n") || empty) + continuation("ticket://", page));
}

/** Without `offset`, the newest lines; with it, the lines from that entry on. */
async function readTranscript(
  source: TranscriptSource,
  conversationId: number,
  args: Args,
  context: Context,
) {
  const limit = Math.min(Math.max(1, args.limit ?? LIST_PAGE.default), LIST_PAGE.max);
  const range = args.offset === undefined ? { limit } : { from: args.offset, limit };
  const page = await source.page(conversationId, range, context);
  const address = formatAddress({ kind: "transcript", conversationId });
  if (page === undefined) return text(`没有找到 ${address}`, true);
  const { lines } = page;
  const matching =
    args.query === undefined ? lines : lines.filter((l) => l.text.includes(args.query ?? ""));
  const body = matching.map((l) => `#${l.id} ${l.role}: ${oneLine(l.text)}`).join("\n");
  const first = lines[0]?.id;
  const hints: string[] = [];
  if (page.earlier && first !== undefined) {
    hints.push(`更早的条目：read("${address}", offset: ${Math.max(0, first - limit)})`);
  }
  if (page.next !== undefined) {
    hints.push(`还有更新的条目：read("${address}", offset: ${page.next})`);
  }
  hints.push(`单条全文：read("${address}/<条目编号>")`);
  return text(`${body || "没有条目。"}\n\n[${hints.join("；")}]`);
}

const LINE_PREVIEW = 200;

function oneLine(value: string): string {
  const flat = value.replaceAll("\n", " ");
  return flat.length > LINE_PREVIEW ? `${flat.slice(0, LINE_PREVIEW - 1)}…` : flat;
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
  ...(isError ? { isError: true } : { structuredOutput: value }),
});
