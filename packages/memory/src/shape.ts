export type NodeRef = {
  readonly level: number;
  readonly index: number;
};

export type ForestNodeRef = NodeRef;

export type Budget = {
  readonly min: number;
  readonly max: number;
};

export const leafRef = (index: number): NodeRef => ({ level: 0, index });
export const spanOf = (node: NodeRef): number => 2 ** node.level;
export const startOf = (node: NodeRef): number => node.index * spanOf(node);
export const endOf = (node: NodeRef): number => startOf(node) + spanOf(node);
export const labelOf = (node: NodeRef): string => `${startOf(node)}+${spanOf(node)}`;
export const keyOf = (node: NodeRef): string => `${node.level}:${node.index}`;

export const parentOf = (node: NodeRef): NodeRef => ({
  level: node.level + 1,
  index: Math.floor(node.index / 2),
});

export const siblingOf = (node: NodeRef): NodeRef => ({
  level: node.level,
  index: node.index % 2 === 0 ? node.index + 1 : node.index - 1,
});

export function childrenOf(node: NodeRef): readonly [NodeRef, NodeRef] {
  if (node.level === 0) throw new RangeError("A leaf has no children");
  const level = node.level - 1;
  return [
    { level, index: node.index * 2 },
    { level, index: node.index * 2 + 1 },
  ];
}

export function nodeAt(start: number, count: number): NodeRef | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) return undefined;
  if (start < 0 || count < 1 || start % count !== 0) return undefined;
  if (start + count > Number.MAX_SAFE_INTEGER) return undefined;
  const bigCount = BigInt(count);
  if ((bigCount & (bigCount - 1n)) !== 0n) return undefined;
  return { level: Math.log2(count), index: start / count };
}

export function covers(view: readonly NodeRef[], count: number): boolean {
  let next = 0;
  for (const node of view) {
    if (startOf(node) !== next) return false;
    next = endOf(node);
  }
  return next === count;
}

/**
 * Merge sibling pairs whose parent is built, most due first, once total size passes `budget.max`,
 * until it fits `budget.min`. Due is measured from the pair's last leaf divided by its span, so
 * older merged lines stay put and preserve the provider prompt-cache prefix.
 */
export function fold(
  view: readonly NodeRef[],
  total: number,
  budget: Budget,
  sizeOf: (node: NodeRef) => number,
  built: (node: NodeRef) => boolean,
): NodeRef[] {
  const nodes = [...view];
  const sizes = nodes.map(sizeOf);
  let size = sizes.reduce((sum, value) => sum + value, 0);
  if (size <= budget.max) return nodes;
  while (size > budget.min) {
    const pair = mostDuePair(nodes, total, built);
    if (pair === undefined) break;
    const parent = parentOf(nodes[pair] as NodeRef);
    const parentSize = sizeOf(parent);
    size += parentSize - (sizes[pair] ?? 0) - (sizes[pair + 1] ?? 0);
    nodes.splice(pair, 2, parent);
    sizes.splice(pair, 2, parentSize);
  }
  return nodes;
}

function mostDuePair(
  nodes: readonly NodeRef[],
  total: number,
  built: (node: NodeRef) => boolean,
): number | undefined {
  let best: number | undefined;
  let bestDue = Number.NEGATIVE_INFINITY;
  for (let at = 0; at + 1 < nodes.length; at++) {
    const left = nodes[at] as NodeRef;
    const right = nodes[at + 1] as NodeRef;
    if (left.level !== right.level || left.index % 2 !== 0 || right.index !== left.index + 1) {
      continue;
    }
    if (!built(parentOf(left))) continue;
    const due = (total - (endOf(right) - 1)) / spanOf(left);
    if (due > bestDue) {
      bestDue = due;
      best = at;
    }
  }
  return best;
}

export function* coverBackward(end: number, built: (node: NodeRef) => boolean): Generator<NodeRef> {
  let cursor = end;
  for (let level = 0; cursor > 0; level++) {
    const span = 2 ** level;
    if ((cursor / span) % 2 !== 1) continue;
    yield* expandBackward({ level, index: cursor / span - 1 }, built);
    cursor -= span;
  }
}

function* expandBackward(node: NodeRef, built: (node: NodeRef) => boolean): Generator<NodeRef> {
  if (node.level === 0 || built(node)) {
    yield node;
    return;
  }
  const [left, right] = childrenOf(node);
  yield* expandBackward(right, built);
  yield* expandBackward(left, built);
}
