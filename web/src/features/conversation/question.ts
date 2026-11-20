/** Class lists shared by the question card and its read-only review. */

const FADE = "animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]";
const CHIP_BG = "bg-[color-mix(in_oklab,var(--fg)_7%,transparent)]";

export const QCARD =
  "qcard flex animate-[ev-rise_var(--ev-regular)_var(--ev-ease)] flex-col rounded-xl border-0 bg-surface shadow-panel";
export const Q_HEAD =
  "flex min-h-11 flex-none items-center gap-2 px-5 text-xs font-medium text-fg-muted";
export const PAGER =
  "inline-flex items-center gap-0.5 text-xs text-fg-subtle tabular-nums [&>button]:inline-grid [&>button]:size-6 [&>button]:place-items-center [&>button]:rounded-sm [&>button]:text-fg-muted hover:[&>button:hover]:bg-hover hover:[&>button:hover]:text-fg";
export const Q_BODY = "flex flex-col gap-4 px-5 pb-1";
export const Q_ITEM = "flex flex-col gap-2";
export const Q_ITEM_T =
  "flex gap-1.5 text-base leading-[1.43] font-medium [&_.n]:text-fg-subtle [&_.n]:tabular-nums";
export const Q_OPTS = "flex flex-col gap-0.5";
export const Q_FOOT = "flex flex-none items-center gap-2 px-5 py-4";

const OPTION =
  "-mx-3 flex min-h-9 items-center gap-2.5 rounded-md py-2 text-left text-sm leading-5 transition-colors focus-visible:shadow-(--ring-inset)";

/** An answer; a chosen one fills its radio. */
export function qOption(on: boolean): string {
  return [
    OPTION,
    "px-3 disabled:cursor-default disabled:opacity-55",
    on
      ? "bg-accent-soft [&>.radio]:border-transparent [&>.radio]:bg-accent [&>.radio]:after:absolute [&>.radio]:after:inset-1 [&>.radio]:after:rounded-full [&>.radio]:after:bg-accent-fg [&>.radio]:after:content-['']"
      : "hover:bg-hover",
  ].join(" ");
}

export const OPT_MORE = `${OPTION} pr-3 pl-9.5 text-fg-muted hover:bg-hover`;
export const RADIO =
  "radio relative size-4 flex-none rounded-full border border-(--ev-input-border) bg-(--ev-well) transition-colors";
export const REC = `ml-auto rounded-xs ${CHIP_BG} px-1.5 py-0.5 text-xs leading-[1.17] font-medium text-fg-muted`;
export const OPT_INPUT = `mt-1 h-(--ev-h-lg) w-full rounded-md border border-(--ev-input-border) bg-(--ev-well) px-3 text-base ${FADE} focus:border-accent focus:shadow-(--ring-field)`;
export const WHY = `pl-6.5 text-xs leading-[1.55] text-fg-muted ${FADE}`;
export const Q_STATUS = "text-xs text-fg-muted";
export const Q_CUSTOM =
  "px-2.5 py-1 text-base leading-[1.43] whitespace-pre-wrap wrap-anywhere text-fg";
