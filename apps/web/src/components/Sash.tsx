import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

export type SashProps = {
  readonly side: "left" | "right";
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly now: number;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
};

export function Sash({ side, label, min, max, now, onResize, onReset }: SashProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, w: now });
  const rafRef = useRef(0);
  const lastXRef = useRef(0);
  const sign = side === "left" ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { x: event.clientX, w: now };
    lastXRef.current = event.clientX;
    setDragging(true);
    document.documentElement.classList.add("ev-sash-drag");
  };

  const onPointerMove = (event: PointerEvent<HTMLHRElement>) => {
    if (!dragging) return;
    lastXRef.current = event.clientX;
    if (rafRef.current !== 0) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      onResize(startRef.current.w + sign * (lastXRef.current - startRef.current.x));
    });
  };

  const endDrag = (event: PointerEvent<HTMLHRElement>) => {
    if (!dragging) return;
    setDragging(false);
    document.documentElement.classList.remove("ev-sash-drag");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release errors.
    }
    if (rafRef.current !== 0) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      onResize(startRef.current.w + sign * (lastXRef.current - startRef.current.x));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -16 : 16;
      onResize(now + sign * step);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onReset();
    }
  };

  return (
    <hr
      className={`ev-sash ${side === "left" ? "s-left" : "s-right"}${dragging ? " active" : ""}`}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(now)}
      tabIndex={0}
      style={{ border: 0, margin: 0 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
