export type Span = {
  readonly start: number;
  readonly size: number;
};

export const leafSpan = (index: number): Span => ({ start: index, size: 1 });
export const endOf = (span: Span): number => span.start + span.size;
export const labelOf = (span: Span): string => `${span.start}+${span.size}`;
export const isLeftHalf = (span: Span): boolean => (span.start / span.size) % 2 === 0;

const LABEL_PATTERN = /^(0|[1-9]\d*)\+([1-9]\d*)$/;

export function spanAt(start: number, size: number): Span | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size)) return undefined;
  if (start < 0 || size < 1 || start % size !== 0) return undefined;
  if (start + size > Number.MAX_SAFE_INTEGER) return undefined;
  const bigSize = BigInt(size);
  if ((bigSize & (bigSize - 1n)) !== 0n) return undefined;
  return { start, size };
}

export function parseLabel(label: string): Span | undefined {
  const match = LABEL_PATTERN.exec(label);
  if (match === null) return undefined;
  return spanAt(Number(match[1]), Number(match[2]));
}

export const parentOf = (span: Span): Span => ({
  start: isLeftHalf(span) ? span.start : span.start - span.size,
  size: span.size * 2,
});

export const partnerOf = (span: Span): Span => ({
  start: isLeftHalf(span) ? span.start + span.size : span.start - span.size,
  size: span.size,
});

export function splitSpan(span: Span): readonly [Span, Span] {
  if (span.size === 1) throw new RangeError("A leaf has no children");
  const half = span.size / 2;
  return [
    { start: span.start, size: half },
    { start: span.start + half, size: half },
  ];
}

export const canMerge = (left: Span, right: Span): boolean =>
  left.size === right.size && isLeftHalf(left) && right.start === left.start + left.size;

export function covers(spans: readonly Span[], count: number): boolean {
  let next = 0;
  for (const span of spans) {
    if (span.size < 1 || span.start !== next) return false;
    next = endOf(span);
  }
  return next === count;
}

export function mergeDue(parent: Span, totalLeaves: number): number {
  const newestLeafInPair = endOf(parent) - 1;
  const age = totalLeaves - newestLeafInPair;
  const childSize = parent.size / 2;
  return age / childSize;
}
