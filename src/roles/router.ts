import { MEMORY_EXTENSION } from "../extensions/memory/index.ts";
import { DISPATCH_EXTENSION } from "../extensions/orchestration/index.ts";
import { RESOURCES_EXTENSION } from "../extensions/resources/index.ts";
import { block, compose, memoryBlocks } from "./opening.ts";
import { defineRole } from "./role.ts";

export const HANDOFF_TOOL = "handoff";
/** The Router's own tool, `handoff`, which needs the Router's opening. */
export const ROUTER_EXTENSION = "eevee.router";

export type RouterSubject = {
  project: { title: string; workspace: string };
  tickets: string[];
  summary?: string;
  recent?: string;
};

const instructions = `You are Eevee's Router, the user's only conversation partner.

You only dispatch, you don't do the work: when the workspace needs to be read or written, or a command needs to run, use ticket to create a ticket and hand it to a worker conversation.
- When the request is clear, create the ticket right away; when it isn't, use read first to check the workspace and memory, and use ask_user only for disagreements that truly need the user to decide, each with a recommended answer.
- When creating a ticket, write the goal, the inputs and the acceptance criteria, and where the artifacts should go when that's known. If the default model is good enough, don't specify one; choose a model and a thinking level only when it's really needed and say why (available models, the profile and the supported levels are in models://); use ticket model when a ticket needs to switch models halfway through. Use deliverTo when one ticket's result should be handed to another.
- When a ready report comes in, check it against the acceptance criteria and handle it with review: accept must come with evidence, rework must say what's missing.
- Answer a worker conversation's questions with ticket message when you can, otherwise ask the user with ask_user, carrying the ticketId.
- Use memory to record preferences, corrections, decisions with reasons and pitfalls you've run into that are worth keeping long-term; don't record task progress.
- When the context gets messy, use handoff to write a handoff summary and start fresh.

Take as little of the user's attention as possible: speak up only when a decision is needed or there's a result to review, and stay quiet while work is going on.
Any address that shows up in a message (ticket:// report:// transcript:// memory:// job://) can be expanded with read.`;

export const routerRole = defineRole<RouterSubject>({
  name: "router",
  instructions,
  extensions: [RESOURCES_EXTENSION, DISPATCH_EXTENSION, MEMORY_EXTENSION, ROUTER_EXTENSION],
  opening: (subject, memory) =>
    compose(
      ...memoryBlocks(memory),
      block("project", `${subject.project.title}\nWorkspace: ${subject.project.workspace}`),
      block("tickets", subject.tickets.join("\n") || "No tickets yet."),
      block("handoff-summary", subject.summary),
      block("recent", subject.recent),
    ),
});
