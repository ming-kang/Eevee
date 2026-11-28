import type {
  ComposerSegment,
  ComposerTextRange,
  ComposerValue,
} from "@earendil-works/elanor-react";
import type {
  SkillEntry,
  TicketRecordPayload,
  WorkerBoardItemPayload,
  WorkspaceFile,
} from "@eevee/protocol";
import { findCodeRanges, overlapsCodeRange } from "./skill-autocomplete.ts";

export type FileChip = {
  readonly kind: "file";
  readonly id: string;
  readonly label: string;
  readonly ref: string;
  readonly name: string;
  readonly dir: string;
};

export type WorkerChip = {
  readonly kind: "worker";
  readonly id: string;
  readonly label: string;
  readonly ref: string;
  readonly name: string;
};

export type TicketChip = {
  readonly kind: "ticket";
  readonly id: string;
  readonly label: string;
  readonly ref: string;
  readonly title: string;
};

export type SkillChip = {
  readonly kind: "skill";
  readonly id: string;
  readonly label: string;
  readonly name: string;
};

export type MessageChip = FileChip | WorkerChip | TicketChip | SkillChip;
export type MessageSegment = ComposerSegment<MessageChip>;
export type MessageValue = ComposerValue<MessageChip>;

const CHIP_PLACEHOLDER = String.fromCharCode(0xfffc);
const WHITESPACE_START = /^\s/;
const WHITESPACE_END = /\s$/;

let nextChipNumber = 1;

function chipId(kind: MessageChip["kind"]): string {
  return `${kind}-${nextChipNumber++}`;
}

export function isMessageChip(segment: MessageSegment | undefined): segment is MessageChip {
  return segment !== undefined && typeof segment !== "string";
}

export function fileChip(file: WorkspaceFile): FileChip {
  return {
    kind: "file",
    id: chipId("file"),
    label: file.label,
    ref: file.label,
    name: file.name,
    dir: file.dir,
  };
}

export function workerChip(worker: WorkerBoardItemPayload): WorkerChip {
  return {
    kind: "worker",
    id: chipId("worker"),
    label: `${worker.id} ${worker.name}`,
    ref: worker.id,
    name: worker.name,
  };
}

export function ticketChip(ticket: TicketRecordPayload): TicketChip {
  return {
    kind: "ticket",
    id: chipId("ticket"),
    label: `${ticket.id} ${ticket.title}`,
    ref: ticket.id,
    title: ticket.title,
  };
}

export function skillChip(skill: SkillEntry): SkillChip {
  return { kind: "skill", id: chipId("skill"), label: skill.name, name: skill.name };
}

export function chipText(chip: MessageChip): string {
  if (chip.kind === "skill") return `/skill:${chip.name}`;
  return /\s/.test(chip.ref) ? `@"${chip.ref}"` : `@${chip.ref}`;
}

/**
 * The engine only recognizes `@mentions` and `/skill:` invocations bounded by whitespace, so each
 * chip is kept apart from the text beside it.
 */
export function messageText(value: MessageValue): string {
  let text = "";
  let afterChip = false;
  for (const segment of value) {
    if (isMessageChip(segment)) {
      const needsGap = text !== "" && !WHITESPACE_END.test(text);
      text += `${needsGap ? " " : ""}${chipText(segment)}`;
      afterChip = true;
      continue;
    }
    if (segment === "") continue;
    text += `${afterChip && !WHITESPACE_START.test(segment) ? " " : ""}${segment}`;
    afterChip = false;
  }
  return text;
}

export function isMessageEmpty(value: MessageValue): boolean {
  return messageText(value).trim() === "";
}

export function normalizeMessageValue(segments: readonly MessageSegment[]): MessageValue {
  const normalized: MessageSegment[] = [];
  for (const segment of segments) {
    if (isMessageChip(segment)) {
      normalized.push(segment);
      continue;
    }
    if (segment === "") continue;
    const last = normalized.at(-1);
    if (typeof last === "string") normalized[normalized.length - 1] = `${last}${segment}`;
    else normalized.push(segment);
  }
  return normalized;
}

export function isInsideCode(value: MessageValue, range: ComposerTextRange): boolean {
  const offsets = value
    .map((segment) => (isMessageChip(segment) ? CHIP_PLACEHOLDER : segment))
    .join("");
  return overlapsCodeRange(
    range.start,
    Math.max(range.end, range.start + 1),
    findCodeRanges(offsets),
  );
}
