import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "vue/compiler-sfc";

test("proposal review is reachable, renders file diffs and wires both decisions", async () => {
  const page = await readFile(new URL("./MemoryPage.vue", import.meta.url), "utf8");
  const review = await readFile(new URL("./ProposalReview.vue", import.meta.url), "utf8");
  assert.deepEqual(parse(review).errors, []);
  assert.match(page, /<ProposalReview v-if="tab === 'proposals'"/);
  assert.match(review, /:diffs="review.detail.value.files"/);
  assert.match(review, /@click="review.approve\(\)"/);
  assert.match(review, /@click="review.reject\(\)"/);
  assert.match(review, /v-model="review.reason.value"/);
});

test("global memory hides create, rename and delete while keeping editing available", async () => {
  const { descriptor, errors } = parse(
    await readFile(new URL("./MemoryPage.vue", import.meta.url), "utf8"),
  );
  assert.deepEqual(errors, []);
  const root = descriptor.template?.ast;
  assert.ok(root);
  type Node = typeof root | (typeof root.children)[number];
  const controls: Record<string, boolean> = {};
  function visit(node: Node, projectOnly = false): void {
    if (node.type !== 0 && node.type !== 1) return;
    if (node.type === 1) {
      projectOnly ||= node.props.some(
        (prop) =>
          prop.type === 7 &&
          prop.name === "if" &&
          prop.exp?.type === 4 &&
          prop.exp.content === "scope === 'project'",
      );
      for (const prop of node.props) {
        if (prop.type !== 7 || prop.name !== "on" || prop.exp?.type !== 4) continue;
        const mode = /editor\.open\('([^']+)'/.exec(prop.exp.content)?.[1];
        if (mode) controls[mode] = projectOnly;
      }
    }
    for (const child of node.children) visit(child, projectOnly);
  }
  visit(root);
  assert.deepEqual(controls, { new: true, edit: false, rename: true, delete: true });
});
