/** Class lists for the composer's round send and stop buttons. */

const ROUND =
  "inline-grid size-(--ev-h-sm) flex-none place-items-center rounded-full transition-[background-color,color,box-shadow,transform] duration-(--ev-fast) enabled:active:scale-94 focus-visible:shadow-(--ring)";

export const SEND = `${ROUND} bg-(--ev-primary) text-(color:--ev-on-primary) shadow-(--ev-shadow-primary) enabled:hover:bg-(--ev-primary-hover) disabled:bg-(--ev-tray) disabled:text-fg-subtle disabled:shadow-none`;

export const STOP = `${ROUND} border border-(--ev-input-border) bg-(--ev-raised) text-fg shadow-(--ev-shadow-raised) enabled:hover:bg-hover [&_.ico]:fill-current`;
