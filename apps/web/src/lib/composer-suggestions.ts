import type {
  ComposerSuggestionMatch,
  ComposerSuggestionTrigger,
} from "@earendil-works/elanor-react";
import type {
  BoardViewPayload,
  SkillEntry,
  TicketRecordPayload,
  WorkerBoardItemPayload,
  WorkspaceFile,
} from "@eevee/protocol";
import { fileChip, type MessageChip, skillChip, ticketChip, workerChip } from "./composer-value.ts";
import { filterBoardMentions, type MentionScope } from "./mention-autocomplete.ts";
import { filterAutocompleteSkills } from "./skill-autocomplete.ts";

const MENTION_TRIGGERS: ReadonlyMap<string, MentionScope> = new Map([
  ["@", "all"],
  ["@file:", "files"],
  ["@files:", "files"],
  ["@worker:", "workers"],
  ["@workers:", "workers"],
  ["@ticket:", "tickets"],
  ["@tickets:", "tickets"],
]);
const SKILL_TRIGGER = "/";
const EXPLICIT_SKILL_TRIGGER = "/skill:";

export const SUGGESTION_TRIGGERS: readonly ComposerSuggestionTrigger[] = [
  ...[...MENTION_TRIGGERS.keys()].map((character) => ({ character })),
  { character: SKILL_TRIGGER },
  { character: EXPLICIT_SKILL_TRIGGER },
];

export type SuggestionTarget =
  | { readonly kind: "mention"; readonly scope: MentionScope; readonly query: string }
  | { readonly kind: "skill"; readonly explicit: boolean; readonly query: string };

export function suggestionTarget(match: ComposerSuggestionMatch): SuggestionTarget | undefined {
  const scope = MENTION_TRIGGERS.get(match.character);
  if (scope) return { kind: "mention", scope, query: match.query };
  if (match.character === EXPLICIT_SKILL_TRIGGER) {
    return { kind: "skill", explicit: true, query: match.query };
  }
  if (match.character === SKILL_TRIGGER) {
    return { kind: "skill", explicit: false, query: match.query };
  }
  return undefined;
}

export function searchesFiles(target: SuggestionTarget): boolean {
  return target.kind === "mention" && (target.scope === "all" || target.scope === "files");
}

export type SuggestionItem =
  | { readonly kind: "skill"; readonly key: string; readonly skill: SkillEntry }
  | { readonly kind: "file"; readonly key: string; readonly file: WorkspaceFile }
  | { readonly kind: "worker"; readonly key: string; readonly worker: WorkerBoardItemPayload }
  | { readonly kind: "ticket"; readonly key: string; readonly ticket: TicketRecordPayload };

export function skillItems(skills: readonly SkillEntry[], query: string): SuggestionItem[] {
  return filterAutocompleteSkills(skills, query).map((skill) => ({
    kind: "skill",
    key: `skill:${skill.name}:${skill.path}`,
    skill,
  }));
}

export function mentionItems(
  files: readonly WorkspaceFile[],
  board: BoardViewPayload | undefined,
  query: string,
  scope: MentionScope,
): SuggestionItem[] {
  const { workers, tickets } = filterBoardMentions(board, query, scope);
  return [
    ...files.map((file) => ({
      kind: "file" as const,
      key: `file:${file.workspace}:${file.path}`,
      file,
    })),
    ...workers.map((worker) => ({ kind: "worker" as const, key: `worker:${worker.id}`, worker })),
    ...tickets.map((ticket) => ({ kind: "ticket" as const, key: `ticket:${ticket.id}`, ticket })),
  ];
}

export function chipForItem(item: SuggestionItem): MessageChip {
  switch (item.kind) {
    case "skill":
      return skillChip(item.skill);
    case "file":
      return fileChip(item.file);
    case "worker":
      return workerChip(item.worker);
    case "ticket":
      return ticketChip(item.ticket);
  }
}
