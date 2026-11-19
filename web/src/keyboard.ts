/** The index a tablist key moves to from `index` among `length` tabs, wrapping around; undefined for other keys. */
export function tabStep(key: string, index: number, length: number): number | undefined {
  if (length === 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % length;
    case "ArrowLeft":
      return (index - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return undefined;
  }
}

/** Whether `now` is a second press of the same key, within `withinMs` of the previous one. */
export function doublePressed(last: number | undefined, now: number, withinMs = 500): boolean {
  return last !== undefined && now - last <= withinMs;
}

/** The index a menu key moves to from `index` among `length` rows, wrapping around; undefined for other keys. */
export function listStep(key: string, index: number, length: number): number | undefined {
  if (length === 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return (index + 1) % length;
    case "ArrowUp":
      return (index - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return undefined;
  }
}
