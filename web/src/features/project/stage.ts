/** Class lists for a ticket's id and its stage, inked for the stages that need someone. */

export const ID_TEXT = "flex-none font-mono text-xs leading-none font-medium text-fg-subtle";

const STAGE_INK: Record<string, string> = {
  answer: "text-(color:--ev-user-ink)",
  review: "text-(color:--ev-ok-ink)",
  blocked: "text-(color:--ev-bad-ink)",
};

const STAGE_FILL: Record<string, string> = {
  answer: "bg-(--ev-user-film) text-(color:--ev-user-ink)",
  review: "bg-(--ev-ok-film) text-(color:--ev-ok-ink)",
  blocked: "bg-(--ev-bad-film) text-(color:--ev-bad-ink)",
};

export function stageText(stage: string): string {
  return `text-xs whitespace-nowrap ${STAGE_INK[stage] ?? "text-fg-subtle"}`;
}

/** The stage beside a Worker conversation's title. */
export function stagePill(stage: string): string {
  return `inline-flex h-6 flex-none items-center gap-1.25 rounded-full px-2 text-(length:--ev-caption) font-medium [&_.glyph]:size-3.25 ${STAGE_FILL[stage] ?? "bg-(--ev-tray) text-fg-muted"}`;
}
