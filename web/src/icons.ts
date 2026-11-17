export type IconPrimitive =
  | { tag: "path"; d: string }
  | { tag: "circle"; cx: number; cy: number; r: number; fill?: string }
  | {
      tag: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      fill?: string;
      stroke?: string;
    };

const p = (d: string): IconPrimitive => ({ tag: "path", d });
const c = (cx: number, cy: number, r: number, fill?: string): IconPrimitive =>
  fill === undefined ? { tag: "circle", cx, cy, r } : { tag: "circle", cx, cy, r, fill };
const r = (
  x: number,
  y: number,
  width: number,
  height: number,
  rx?: number,
  fill?: string,
  stroke?: string,
): IconPrimitive => ({
  tag: "rect",
  x,
  y,
  width,
  height,
  ...(rx === undefined ? {} : { rx }),
  ...(fill === undefined ? {} : { fill }),
  ...(stroke === undefined ? {} : { stroke }),
});

export const ICONS = {
  search: [c(11, 11, 7), p("m20 20-3.5-3.5")],
  plus: [p("M12 5v14M5 12h14")],
  sliders: [
    p("M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"),
    c(15, 6, 2),
    c(9, 12, 2),
    c(17, 18, 2),
  ],
  bell: [p("M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 8-2.5 8h17S18 15 18 8.5M10.3 20a1.9 1.9 0 0 0 3.4 0")],
  radio: [
    c(12, 12, 2),
    p(
      "M8.2 7.8a6 6 0 0 0 0 8.4M15.8 7.8a6 6 0 0 1 0 8.4M5.3 4.9a10 10 0 0 0 0 14.2M18.7 4.9a10 10 0 0 1 0 14.2",
    ),
  ],
  book: [
    p("M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"),
    p("M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6M9 11h4"),
  ],
  chart: [p("M4 20h16M7 16v-5M12 16V6M17 16v-8")],
  chevR: [p("m9 6 6 6-6 6")],
  chevL: [p("m15 6-6 6 6 6")],
  chevD: [p("m6 9 6 6 6-6")],
  chevU: [p("m6 15 6-6 6 6")],
  arrowUp: [p("M12 19V5M6 11l6-6 6 6")],
  arrowR: [p("M5 12h14M13 6l6 6-6 6")],
  stop: [r(7, 7, 10, 10, 1.5, "currentColor", "none")],
  x: [p("M6 6l12 12M18 6 6 18")],
  check: [p("m5 12.5 4.5 4.5L19 7.5")],
  file: [p("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"), p("M14 3v5h5")],
  term: [r(3, 4, 18, 16, 2), p("m7 9 3 3-3 3M13 15h4")],
  pencil: [p("M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"), p("m13.5 6.5 4 4")],
  clock: [c(12, 12, 9), p("M12 7v5l3 2")],
  menu: [p("M4 7h16M4 12h16M4 17h16")],
  panel: [r(3, 4, 18, 16, 2), p("M15 4v16")],
  copy: [r(8, 8, 12, 12, 2), p("M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2")],
  refresh: [p("M20 11a8 8 0 0 0-14.6-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.4L20 16M20 20v-4h-4")],
  undo: [p("M9 14 4 9l5-5"), p("M4 9h10.5a5.5 5.5 0 0 1 0 11H11")],
  commit: [c(12, 12, 3.5), p("M3 12h5.5M15.5 12H21")],
  moon: [p("M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z")],
  user: [c(12, 8, 4), p("M4.5 21a7.5 7.5 0 0 1 15 0")],
  wrench: [
    p("M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5v3h3l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.3-.6-.6-2.3z"),
  ],
  puzzle: [
    p(
      "M10 4a2 2 0 0 1 4 0v1.5h3.5a1 1 0 0 1 1 1V10H17a2 2 0 0 0 0 4h1.5v3.5a1 1 0 0 1-1 1H14V17a2 2 0 0 0-4 0v1.5H6.5a1 1 0 0 1-1-1V14H7a2 2 0 0 0 0-4H5.5V6.5a1 1 0 0 1 1-1H10z",
    ),
  ],
  plug: [p("M9 2.5v5M15 2.5v5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v5")],
  cpu: [
    r(6, 6, 12, 12, 2),
    r(9.5, 9.5, 5, 5, 1),
    p("M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"),
  ],
  server: [r(3, 4, 18, 7, 2), r(3, 13, 18, 7, 2), p("M7 7.5h.01M7 16.5h.01")],
  key: [c(8, 15, 4), p("m11 12 9-9M17 6l3 3M14.5 8.5l2 2")],
  folder: [p("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")],
  help: [c(12, 12, 9), p("M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.5M12 17h.01")],
  flag: [p("M5 21V4M5 4h11.5l-2 4 2 4H5")],
  box: [p("m12 3 8 4.5v9L12 21l-8-4.5v-9z"), p("m4 7.5 8 4.5 8-4.5M12 12v9")],
  bulb: [
    p(
      "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.1 2.2h5c0-1 .5-1.7 1.1-2.2A6 6 0 0 0 12 3z",
    ),
  ],
  link: [
    p(
      "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    ),
  ],
  alert: [p("M12 3 2.5 20h19zM12 10v4.5M12 17.5h.01")],
  lock: [r(5, 11, 14, 10, 2), p("M8 11V8a4 4 0 0 1 8 0v3")],
  sun: [
    c(12, 12, 4),
    p(
      "M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4",
    ),
  ],
  eye: [p("M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"), c(12, 12, 3)],
  layers: [p("m12 3 9 5-9 5-9-5zM3 13l9 5 9-5")],
  send: [p("M4 12 20 4l-5 16-3-7z"), p("m12 13 8-9")],
  dot3: [
    c(5, 12, 1.3, "currentColor"),
    c(12, 12, 1.3, "currentColor"),
    c(19, 12, 1.3, "currentColor"),
  ],
  spinner: [p("M12 3a9 9 0 1 0 9 9")],
} as const satisfies Record<string, readonly IconPrimitive[]>;

export type IconName = keyof typeof ICONS;
