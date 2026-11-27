import type { Context } from "@earendil-works/chord/context";
import {
  CompactionEntry,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  type HookRegistration,
  hook,
  ResetEntry,
} from "@earendil-works/pi-durable";
import { isTaskActiveStatus, listConversationTasks } from "./docs.ts";
import { formatTaskSummaryLine } from "./tasks-tool.ts";

const COMPACTION_SCAN_PAGE = 64;
export const MAX_REMINDED_CONVERSATIONS = 256;

export async function findLatestCompaction(
  api: {
    entries(
      query: { readonly order?: "ascending" | "descending" },
      limit: number,
      cursor: Cursor | undefined,
      context: Context,
    ): Promise<{ readonly items: readonly EntryRecord[]; readonly next?: Cursor }>;
  },
  context: Context,
): Promise<EntryRecord | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries({ order: "descending" }, COMPACTION_SCAN_PAGE, cursor, context);
    for (const entry of page.items) {
      if (CompactionEntry.is(entry)) return entry;
      if (ResetEntry.is(entry)) return undefined;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return undefined;
}

export function createCompactionReminderHook(): HookRegistration {
  const remindedCompaction = new Map<ConversationId, EntryId>();

  const remember = (conversationId: ConversationId, entryId: EntryId): void => {
    remindedCompaction.delete(conversationId);
    remindedCompaction.set(conversationId, entryId);
    if (remindedCompaction.size > MAX_REMINDED_CONVERSATIONS) {
      const oldest = remindedCompaction.keys().next().value;
      if (oldest !== undefined) {
        remindedCompaction.delete(oldest);
      }
    }
  };

  return hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const records = await listConversationTasks(api, api.conversationId, context);
      const active = records.filter((record) => isTaskActiveStatus(record.status));
      if (active.length === 0) return undefined;

      const latestCompaction = await findLatestCompaction(api, context);
      if (latestCompaction === undefined) {
        remindedCompaction.delete(api.conversationId);
        return undefined;
      }
      if (remindedCompaction.get(api.conversationId) === latestCompaction.id) {
        remember(api.conversationId, latestCompaction.id);
        return undefined;
      }

      remember(api.conversationId, latestCompaction.id);
      const compactionTime = latestCompaction.model?.[0]?.timestamp;
      const preCompactionActive =
        compactionTime === undefined
          ? active
          : active.filter((record) => record.startedAt <= compactionTime);
      if (preCompactionActive.length === 0) return undefined;

      const reminder =
        "Active background tasks from before compaction are still running in this conversation. " +
        "Do not restart or duplicate them; wait for their automatic completion notice or inspect them with tasks:\n" +
        preCompactionActive.map(formatTaskSummaryLine).join("\n");
      return {
        messages: [
          ...request.messages,
          {
            role: "user",
            content: [{ type: "text", text: reminder }],
            timestamp: api.now(),
          },
        ],
      };
    },
  });
}
