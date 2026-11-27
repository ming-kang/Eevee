import { contentText, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, type EntryRecord, SystemEntry } from "@earendil-works/pi-durable";
import { isRecord } from "../../shared/guards.ts";

export type FileOperations = {
  readonly read: Set<string>;
  readonly written: Set<string>;
  readonly edited: Set<string>;
};

export type CompactionFileLists = {
  readonly readFiles: string[];
  readonly modifiedFiles: string[];
};

export type KeptStart = {
  readonly text: string;
  readonly fromEnd: number;
  readonly count: number;
};

export type ReconstructedContext = {
  readonly messages: Message[];
  readonly keptMessages: Message[];
};

const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

type Edit = NonNullable<EntryRecord["edits"]>[number];

function contributeEntry(entry: EntryRecord, edit: Edit | undefined): readonly Message[] {
  if (edit?.action === "omit") return [];
  const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
  return contributed.filter(
    (message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason),
  );
}

function missingResult(call: { id: string; name: string }, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: MISSING_RESULT_TEXT }],
    isError: true,
    details: { reason: "missing_result" },
    timestamp,
  };
}

function orderToolResults(messages: readonly Message[]): Message[] {
  const ordered: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as Message;
    if (message.role === "toolResult") continue;
    ordered.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.filter((content) => content.type === "toolCall");
    if (calls.length === 0) continue;
    const results = new Map<string, number>();
    for (
      let next = index + 1;
      next < messages.length && (messages[next] as Message).role !== "assistant";
      next++
    ) {
      const candidate = messages[next] as Message;
      if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
        results.set(candidate.toolCallId, next);
      }
    }
    for (const call of calls) {
      const resultIndex = results.get(call.id);
      ordered.push(
        resultIndex === undefined
          ? missingResult(call, message.timestamp)
          : (messages[resultIndex] as Message),
      );
    }
  }
  return ordered;
}

function carriesSystemMessage(entry: EntryRecord): boolean {
  const isSystem = (message: Message) => message.role === "system";
  return (
    (entry.model?.some(isSystem) ?? false) ||
    (entry.edits?.some((edit) => edit.action === "replace" && edit.messages.some(isSystem)) ??
      false)
  );
}

function findBaseline(
  head: EntryRecord | undefined,
  entries: readonly EntryRecord[],
): Message | null | undefined {
  for (const entry of entries) {
    if (head !== undefined && entry.id <= head.id) continue;
    if (SystemEntry.is(entry))
      return entry.model?.find((message) => message.role === "system") ?? null;
    if (head === undefined && carriesSystemMessage(entry)) return null;
  }
  return undefined;
}

function leadWithSystem(messages: Message[], baseline: Message | null | undefined): Message[] {
  const index = messages.findIndex((message) => message.role === "system");
  if (index <= 0) return messages;
  const system = messages[index] as Message;
  if (system !== baseline && messages.slice(0, index).some((message) => message.role !== "user")) {
    return messages;
  }
  return [system, ...messages.slice(0, index), ...messages.slice(index + 1)];
}

/**
 * Rebuild the model context a generation over the same entries would send, from the compacted prefix
 * and the raw transcript scan of the kept suffix. Mirrors pi-durable's `deriveRange` so the prefix
 * matches the last request byte-for-byte and the provider prompt cache hits.
 */
export function reconstructConversationMessages(
  summarizedEntries: readonly EntryRecord[],
  keptEntries: readonly EntryRecord[],
): ReconstructedContext {
  const first = summarizedEntries[0];
  const head = first?.head !== undefined ? first : undefined;
  const byId = new Map<number, EntryRecord>();
  for (const entry of [...summarizedEntries, ...keptEntries]) byId.set(entry.id, entry);
  const edits = new Map<number, Edit>();
  for (const entry of [...byId.values()].sort((a, b) => a.id - b.id)) {
    for (const edit of entry.edits ?? []) edits.set(edit.target, edit);
  }
  const summarizedIds = new Set(summarizedEntries.map((entry) => entry.id));
  const activeSummarized = summarizedEntries;
  const activeKept = keptEntries
    .filter((entry) => entry.head === undefined && !summarizedIds.has(entry.id))
    .sort((a, b) => a.id - b.id);
  const active = [...activeSummarized, ...activeKept];
  const contributions = active.map((entry) => contributeEntry(entry, edits.get(entry.id)));
  const ordered = orderToolResults(contributions.flat());
  const baseline = findBaseline(head, active);
  const messages = leadWithSystem(ordered, baseline);
  const keptMessages = activeKept.flatMap((entry) => [
    ...contributeEntry(entry, edits.get(entry.id)),
  ]);
  return { messages, keptMessages };
}

function sameMessage(candidate: Message, message: Message): boolean {
  return candidate === message || JSON.stringify(candidate) === JSON.stringify(message);
}

function messagePreview(message: Message): string | undefined {
  let text: string | undefined;
  if (message.role === "user") {
    text = contentText(message.content);
  } else if (message.role === "assistant") {
    text = message.content
      .flatMap((block) =>
        block.type === "text"
          ? [block.text]
          : block.type === "toolCall"
            ? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`]
            : [],
      )
      .join("\n");
  }
  text = text?.trim();
  if (!text) return undefined;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Locate the boundary the kept messages start at within the reconstructed conversation. Prefers
 * object identity when messages come from `reconstructConversationMessages`, falling back to the
 * last structurally equal message so repeated earlier content cannot shift the boundary backward.
 */
export function keptStart(
  conversation: readonly Message[],
  keptMessages: readonly Message[],
): KeptStart | undefined {
  let at = -1;
  for (const message of keptMessages) {
    if (messagePreview(message) === undefined) continue;
    const byRef = conversation.indexOf(message);
    at =
      byRef !== -1
        ? byRef
        : conversation.findLastIndex((candidate) => sameMessage(candidate, message));
    if (at !== -1) break;
  }
  if (at === -1) return undefined;
  const previews = conversation.slice(at).map(messagePreview);
  const text = previews[0];
  if (text === undefined) return undefined;
  return {
    text,
    fromEnd: previews.filter((preview) => preview === text).length,
    count: previews.length,
  };
}

export function summaryInstruction(kept: KeptStart, customInstructions?: string): string {
  const repeated =
    kept.fromEnd > 1
      ? ` Several retained messages begin with this text. The boundary is occurrence ${kept.fromEnd}, counting backward from the end of the conversation.`
      : "";
  const toolCalls = kept.text.includes("[tool call: ")
    ? " Tool calls are written as [tool call: name arguments]."
    : "";
  const focus = customInstructions?.trim()
    ? `\n\nAdditional focus from the user:\n${customInstructions.trim()}`
    : "";
  return `Stop working on the current task. Do not call any tools.

Write a structured context checkpoint summary of the earlier part of this conversation. Another LLM will continue the task from your summary, followed by the last ${kept.count} messages, which will remain in context verbatim.

The retained messages begin with the message that starts with this text.${repeated}${toolCalls}

<kept-start>
${kept.text}
</kept-start>

Summarize only the messages before that boundary, as if the conversation had ended immediately before it. Work occurring at or after the boundary has not happened as far as this summary is concerned: do not list it as completed. If it was already planned, include it under Next Steps instead.

If the conversation contains an earlier checkpoint summary, fold its still-relevant facts into this summary and update its progress and next steps.

Use exactly this structure:

## Goal
[What the user is trying to accomplish. Include multiple goals if applicable.]

## Constraints & Preferences
- [Requirements, preferences, and explicit constraints from the user]
- [Use "(none)" when appropriate]

## Progress
### Done
- [x] [Work completed before the boundary]

### In Progress
- [ ] [Work underway at the boundary]

### Blocked
- [Issues preventing progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered steps needed to continue]

## Critical Context
- [Exact information needed to continue: file paths, symbols, commands, important tool results, error messages, and relevant technical details]

Be concise but preserve information required to continue without rereading the original conversation. Keep exact file paths, function names, commands, and error messages. Do not include file-operation lists; they will be added automatically. Return only the summary.${focus}`;
}

function parseFileBlock(text: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const files: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const body = match[1];
    if (body === undefined) continue;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) files.push(trimmed);
    }
  }
  return files;
}

function addFileOp(fileOps: FileOperations, toolName: string, path: unknown): void {
  if (typeof path !== "string" || path.length === 0) return;
  switch (toolName) {
    case "read":
      fileOps.read.add(path);
      break;
    case "write":
      fileOps.written.add(path);
      break;
    case "edit":
      fileOps.edited.add(path);
      break;
  }
}

function extractCodemodeCalls(details: unknown, fileOps: FileOperations): void {
  if (!isRecord(details) || !Array.isArray(details.calls)) return;
  for (const call of details.calls) {
    if (!isRecord(call) || typeof call.name !== "string" || typeof call.args !== "string") {
      continue;
    }
    // CodemodeNestedCall.args is compact JSON cut for display; a truncated tail is not valid JSON.
    try {
      const args: unknown = JSON.parse(call.args);
      if (isRecord(args)) addFileOp(fileOps, call.name, args.path);
    } catch {}
  }
}

/**
 * File operations of the compacted prefix: direct `read`/`write`/`edit` tool calls, nested calls a
 * codemode script made, and the file lists a prior compaction recorded in its summary, so repeated
 * compaction keeps the cumulative history without extra stored state.
 */
export function extractFileOps(entries: readonly EntryRecord[]): FileOperations {
  const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
  for (const entry of entries) {
    if (CompactionEntry.is(entry)) {
      const text = (entry.model ?? [])
        .filter((message) => message.role === "user")
        .map((message) => contentText(message.content))
        .join("\n");
      for (const file of parseFileBlock(text, "read-files")) fileOps.read.add(file);
      for (const file of parseFileBlock(text, "modified-files")) fileOps.edited.add(file);
    }
    for (const message of entry.model ?? []) {
      if (message.role === "assistant" && !EXCLUDED_STOP_REASONS.has(message.stopReason)) {
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          if (isRecord(block.arguments)) addFileOp(fileOps, block.name, block.arguments.path);
        }
      } else if (message.role === "toolResult" && message.toolName === "codemode") {
        extractCodemodeCalls(message.details, fileOps);
      }
    }
  }
  return fileOps;
}

export function computeFileLists(fileOps: FileOperations): CompactionFileLists {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

export function formatFileOperations(
  readFiles: readonly string[],
  modifiedFiles: readonly string[],
): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * The authoritative checkpoint summary: file-operation blocks the model emitted despite being told
 * not to are stripped, and the extracted lists are appended instead.
 */
export function checkpointSummary(
  text: string,
  fileOps: FileOperations,
): { summary: string; readFiles: string[]; modifiedFiles: string[] } {
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  const body = text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
  const operations = formatFileOperations(readFiles, modifiedFiles);
  // The formatter prefixes a non-empty operation list; an empty summary body has no leading blank lines.
  const summary = body ? body + operations : operations.slice(2);
  return { summary, readFiles, modifiedFiles };
}
