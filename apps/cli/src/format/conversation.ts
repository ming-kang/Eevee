import {
  type ConversationViewPayload,
  type EntryRecordPayload,
  parseLiveDocPayload,
} from "@eevee/protocol";
import { isRecord } from "../args.ts";

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractAssistantTextFromMessage(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  return extractContentText(message.content);
}

function extractEntryAssistantText(entry: EntryRecordPayload): string {
  if (!Array.isArray(entry.model)) return "";
  return entry.model.map((msg) => extractAssistantTextFromMessage(msg)).join("");
}

function extractAssistantExtraLines(entry: EntryRecordPayload): string[] {
  const lines: string[] = [];
  if (!Array.isArray(entry.model)) return lines;
  for (const msg of entry.model) {
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
          const args = isRecord(block.arguments) ? JSON.stringify(block.arguments) : "{}";
          lines.push(`[toolCall] ${block.name}(${args})`);
        }
      }
    }
    if (msg.stopReason === "error" && typeof msg.errorMessage === "string" && msg.errorMessage) {
      lines.push(`[error] ${msg.errorMessage}`);
    }
  }
  return lines;
}

function formatNonAssistantEntryLines(entry: EntryRecordPayload): string[] {
  if (entry.kind === "pi.system") return [];
  if (entry.kind === "pi.compaction") return ["[compaction] Context summarized"];

  const lines: string[] = [];
  if (entry.kind === "pi.reset") {
    lines.push("[reset]");
  }

  if (!Array.isArray(entry.model)) return lines;
  for (const msg of entry.model) {
    if (!isRecord(msg) || typeof msg.role !== "string") continue;
    if (msg.role === "user") {
      const text = extractContentText(msg.content).trim();
      if (text.length > 0) {
        const label = entry.kind === "eevee.notice" ? "notice" : "user";
        lines.push(`[${label}] ${text}`);
      }
    } else if (msg.role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const isError = msg.isError === true ? " error" : "";
      const text = extractContentText(msg.content).trim();
      lines.push(`[toolResult:${toolName}${isError}] ${text}`);
    }
  }
  return lines;
}

function isAssistantEntry(entry: EntryRecordPayload): boolean {
  if (entry.kind === "pi.assistant") return true;
  return (
    Array.isArray(entry.model) &&
    entry.model.some((msg) => isRecord(msg) && msg.role === "assistant")
  );
}

export class ConversationWatchRenderer {
  readonly #write: (text: string) => void;
  readonly #renderedEntryIds = new Set<number>();
  #livePrefix = "";
  #liveAttempt: number | undefined;

  constructor(write: (text: string) => void) {
    this.#write = write;
  }

  onSnapshot(view: ConversationViewPayload): void {
    this.#applyView(view);
  }

  onPatch(view: ConversationViewPayload): void {
    this.#applyView(view);
  }

  onFailed(message: string): void {
    this.#flushOpenLiveLine();
    this.#write(`[failed] ${message}\n`);
  }

  onEnd(): void {
    this.#flushOpenLiveLine();
  }

  #applyView(view: ConversationViewPayload): void {
    for (const entry of view.entries) {
      if (this.#renderedEntryIds.has(entry.id)) continue;
      this.#renderedEntryIds.add(entry.id);

      if (isAssistantEntry(entry)) {
        const text = extractEntryAssistantText(entry);
        if (this.#livePrefix.length > 0) {
          if (text.startsWith(this.#livePrefix)) {
            const remaining = text.slice(this.#livePrefix.length);
            if (remaining.length > 0) this.#write(remaining);
            this.#write("\n");
          } else {
            this.#write("\n");
            if (text.length > 0) this.#write(`[assistant] ${text}\n`);
          }
          this.#livePrefix = "";
          this.#liveAttempt = undefined;
        } else if (text.length > 0) {
          this.#write(`[assistant] ${text}\n`);
        }
        for (const extra of extractAssistantExtraLines(entry)) {
          this.#write(`${extra}\n`);
        }
      } else {
        const lines = formatNonAssistantEntryLines(entry);
        if (lines.length > 0) {
          this.#flushOpenLiveLine();
          for (const line of lines) this.#write(`${line}\n`);
        }
      }
    }

    const liveDoc = parseLiveDocPayload(view.docs["pi.live"]);
    const generation = liveDoc?.generation;
    const liveMessage = generation?.message;
    if (liveMessage !== undefined) {
      const attempt = generation?.attempt;
      if (
        attempt !== undefined &&
        this.#liveAttempt !== undefined &&
        attempt !== this.#liveAttempt
      ) {
        this.#flushOpenLiveLine();
      }
      this.#liveAttempt = attempt;

      const liveText = extractAssistantTextFromMessage(liveMessage);
      if (liveText.length > 0) {
        if (this.#livePrefix.length === 0) {
          this.#write(`[assistant] ${liveText}`);
          this.#livePrefix = liveText;
        } else if (liveText.startsWith(this.#livePrefix)) {
          const delta = liveText.slice(this.#livePrefix.length);
          if (delta.length > 0) {
            this.#write(delta);
            this.#livePrefix = liveText;
          }
        } else {
          this.#write(`\n[assistant] ${liveText}`);
          this.#livePrefix = liveText;
        }
      }
    } else if (this.#livePrefix.length > 0) {
      this.#flushOpenLiveLine();
    }
  }

  #flushOpenLiveLine(): void {
    if (this.#livePrefix.length > 0) {
      this.#write("\n");
      this.#livePrefix = "";
    }
    this.#liveAttempt = undefined;
  }
}
