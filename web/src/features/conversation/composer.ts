/** Class lists for the composer's round send and stop buttons. */

const ROUND =
  "inline-grid size-8 flex-none place-items-center rounded-full transition-[background-color,color,box-shadow,transform] duration-(--ev-fast) enabled:active:scale-94 focus-visible:shadow-(--ring)";

export const SEND = `${ROUND} bg-accent text-accent-fg enabled:hover:bg-accent-hover disabled:bg-(--ev-tray) disabled:text-fg-subtle`;

export const STOP = `${ROUND} border border-(--ev-input-border) bg-(--ev-raised) text-fg shadow-(--ev-shadow-raised) enabled:hover:bg-hover [&_.ico]:fill-current`;
