export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, idx) => deepEqualJson(item, b[idx]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (k) => Object.hasOwn(b, k) && b[k] !== undefined && deepEqualJson(a[k], b[k]),
    );
  }
  return false;
}
