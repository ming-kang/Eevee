import { type Leaf, sourceOf } from "./leaf.ts";
import { coverBackward, labelOf, type NodeRef } from "./shape.ts";
import { fitTokens, oneLine } from "./text.ts";

export const LINE_TOKENS = 160;

export const PENDING_LINE = "(not summarized yet: zoom it)";

export type MemoryNodeReader = {
  node(ref: NodeRef): string | undefined;
  leaf(index: number): Leaf | undefined;
};

export function nodeText(store: MemoryNodeReader, node: NodeRef): string | undefined {
  const built = store.node(node);
  if (built !== undefined) return oneLine(built);
  if (node.level !== 0) return undefined;
  const leaf = store.leaf(node.index);
  return leaf && `${PENDING_LINE} ${fitTokens(oneLine(sourceOf(leaf)), LINE_TOKENS)}`;
}

export const lineOf = (store: MemoryNodeReader, node: NodeRef): string =>
  `${labelOf(node)}|${nodeText(store, node) ?? PENDING_LINE}`;

export function textsBefore(store: MemoryNodeReader, end: number, count: number): string[] {
  const texts: string[] = [];
  for (const node of coverBackward(end, (n) => store.node(n) !== undefined)) {
    if (texts.length >= count) break;
    const text = nodeText(store, node);
    if (text !== undefined) texts.push(text);
  }
  return texts.reverse();
}
