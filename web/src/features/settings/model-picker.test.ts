import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "vue/compiler-sfc";

test("Settings model and thinking pickers stay inside their mousedown dismissal boundary", async () => {
  const source = await readFile(new URL("./SettingsPage.vue", import.meta.url), "utf8");
  const selector = source.match(/target\?\.closest\("(\.[\w-]+)"\)/)?.[1];
  assert.ok(selector, "the outside-click handler must identify its containment boundary");
  const boundaryClass = selector.slice(1);
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const root = descriptor.template?.ast;
  assert.ok(root);
  type TemplateNode = typeof root | (typeof root.children)[number];
  const controls: { name: string; inside: boolean }[] = [];

  function visit(node: TemplateNode, inside = false): void {
    if (node.type !== 0 && node.type !== 1) return;
    if (node.type === 1) {
      inside ||= node.props.some(
        (prop) =>
          prop.type === 6 &&
          prop.name === "class" &&
          prop.value?.content.split(/\s+/).includes(boundaryClass),
      );
      if (
        node.tag === "ModelMenu" ||
        node.tag === "LevelMenu" ||
        node.props.some(
          (prop) =>
            prop.type === 7 &&
            prop.name === "on" &&
            prop.exp?.type === 4 &&
            prop.exp.content.startsWith("togglePop("),
        )
      ) {
        controls.push({ name: node.tag, inside });
      }
    }
    for (const child of node.children) visit(child, inside);
  }

  visit(root);
  assert.equal(controls.length, 4, "both menus and their triggers must be covered");
  for (const control of controls) {
    assert.equal(control.inside, true, `${control.name} must be inside ${selector}`);
  }
});
