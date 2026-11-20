import type { Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import {
  type Conversation,
  type ConversationWindow,
  type ConversationView as DurableView,
  type EntryQuery,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type InboxItem,
  LiveDoc,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { NoticeData } from "../../domain/details.ts";
import type { ConversationRef } from "../../domain/index.ts";
import { ProblemError, type TicketId } from "../../domain/index.ts";
import type { ConversationView } from "../../protocol/contract.ts";
import { TicketDoc } from "../docs.ts";
import { conversationOf, NOTICE_KIND } from "../orchestration/index.ts";
import { conversationView } from "../views.ts";
import type { Dispatch } from "./dispatch.ts";

type Deps = { harness: Harness; root: Conversation; context: Context; dispatch: Dispatch };

export class Conversations {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async send(ref: ConversationRef, text: string, whenBusy?: "steer" | "followUp"): Promise<void> {
    if (ref === "router") {
      if (whenBusy !== undefined) throw new ProblemError({ code: "invalid", field: "mode" });
      await this.#deps.dispatch({ type: "user-message", id: crypto.randomUUID(), text });
      return;
    }
    await this.#openTicket(ref);
    await this.#deps.dispatch({
      type: "panel-message",
      id: crypto.randomUUID(),
      ticketId: ref,
      text,
      whenBusy: whenBusy ?? "steer",
    });
  }

  async interrupt(ref: ConversationRef): Promise<void> {
    if (ref === "router") {
      await this.#interruptConversation(this.#deps.root);
      return;
    }
    const worker = await this.#conversationOf(ref);
    await this.#openTicket(ref);
    await this.#interruptConversation(worker);
    await this.#deps.dispatch({ type: "panel-interrupt", id: crypto.randomUUID(), ticketId: ref });
  }

  async view(
    ref: ConversationRef,
    limit = ref === "router" ? 100 : 200,
  ): Promise<ConversationView> {
    return conversationView(
      this.#deps.harness,
      await this.#conversationOf(ref === "router" ? undefined : ref),
      limit,
      this.#deps.context,
    );
  }
  async #interruptConversation(conversation: Conversation): Promise<void> {
    const inbox = await this.#deps.harness.snapshot(InboxDoc, conversation.id, this.#deps.context);
    const kept = (inbox?.items ?? []).filter(
      (item) => item.mode !== "write" && item.entry?.kind === NOTICE_KIND,
    );
    await conversation.abort(this.#deps.context);
    if (kept.length === 0) return;
    await conversation.commit(async (tx) => {
      for (const item of kept) {
        if (item.mode === "write") continue;
        const data = (item.entry?.data ?? {}) as NoticeData;
        const requestId = `${data.requestId ?? item.id}:kept`;
        await conversation.submit(tx, {
          type: "write",
          requestId,
          entry: {
            kind: NOTICE_KIND,
            data: { ...data, requestId },
            model: [{ role: "user", content: item.content, timestamp: Date.now() }],
          },
        });
      }
    }, this.#deps.context);
  }

  async withdrawQueued(ref: ConversationRef, submissionId: string): Promise<void> {
    const ticketId = ref === "router" ? undefined : ref;
    const conversation = await this.#conversationOf(ticketId);
    const item = await this.#queuedItem(conversation, submissionId);
    if (item !== undefined && (item.mode === "write" || item.entry !== undefined)) {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
    await this.#abortSubmission(conversation, submissionId);
    if (ticketId !== undefined && item !== undefined) {
      await this.#deps.dispatch({
        type: "panel-withdrawn",
        id: submissionId,
        ticketId,
        text: inputText(item.content),
      });
    }
  }

  async steerQueued(ref: ConversationRef, submissionId: string): Promise<void> {
    if (ref === "router") throw new ProblemError({ code: "invalid", field: "conversation" });
    await this.#openTicket(ref);
    const conversation = await this.#conversationOf(ref);
    const item = await this.#queuedItem(conversation, submissionId);
    if (item === undefined || item.mode !== "followUp" || item.entry !== undefined) {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
    await this.#abortSubmission(conversation, submissionId);
    await conversation.submit(
      {
        type: "input",
        requestId: `steer:${submissionId}`,
        content: item.content as UserInput,
        whenBusy: "steer",
      },
      this.#deps.context,
    );
  }

  async #queuedItem(
    conversation: Conversation,
    submissionId: string,
  ): Promise<InboxItem | undefined> {
    const inbox = await this.#deps.harness.snapshot(InboxDoc, conversation.id, this.#deps.context);
    return inbox?.items.find((item) => String(item.id) === submissionId);
  }

  async #abortSubmission(conversation: Conversation, submissionId: string): Promise<void> {
    const result = await this.#deps.harness.abortSubmission(
      Number(submissionId) as SubmissionId,
      this.#deps.context,
      conversation.id,
    );
    if (result === "already_placed" || result === "settled") {
      throw new ProblemError({ code: "already_delivered" });
    }
    if (result === "not_found") {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
  }

  async retry(ref: ConversationRef): Promise<void> {
    const ticketId = ref === "router" ? undefined : ref;
    if (ticketId !== undefined) await this.#openTicket(ticketId);
    const conversation = await this.#conversationOf(ticketId);
    const live = await this.#deps.harness.snapshot(LiveDoc, conversation.id, this.#deps.context);
    if (live?.run !== undefined) throw new ProblemError({ code: "running" });
    if (live?.runFailure === undefined) throw new ProblemError({ code: "not_failed" });
    await conversation.submit({ type: "continue" }, this.#deps.context);
  }

  async watch(
    ref: ConversationRef,
    context: Context,
    window?: ConversationWindow,
  ): Promise<WatchHandle<DurableView>> {
    return (await this.#conversationOf(ref === "router" ? undefined : ref)).watch(context, window);
  }

  async entries(
    ref: ConversationRef,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
  ): Promise<EntryRecord[]> {
    const ticketId = ref === "router" ? undefined : ref;
    const conversation = await this.#conversationOf(ticketId);
    const page = await conversation.entries(query, limit, undefined, this.#deps.context);
    return [...page.items];
  }

  async #openTicket(id: TicketId) {
    const ticket = await this.#deps.harness.snapshot(TicketDoc, id, this.#deps.context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId: id });
    if (ticket.status !== "open") throw new ProblemError({ code: "ticket_closed", ticketId: id });
    return ticket;
  }

  async #conversationOf(ticketId?: TicketId): Promise<Conversation> {
    if (ticketId === undefined) return this.#deps.root;
    const ticket = await this.#deps.harness.snapshot(TicketDoc, ticketId, this.#deps.context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId });
    const conversation = await this.#deps.harness.conversation(
      conversationOf(ticket),
      this.#deps.context,
    );
    if (conversation === undefined) throw new ProblemError({ code: "no_worker", ticketId });
    return conversation;
  }
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("")
    .trim();
}
