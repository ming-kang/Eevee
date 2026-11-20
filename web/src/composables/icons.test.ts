import assert from "node:assert/strict";
import { test } from "node:test";
import { h } from "vue";
import { renderToString } from "vue/server-renderer";
import { ICONS } from "./icons.ts";

test("maximize and restore icons render distinct outward/inward arrows, not panel controls", async () => {
  const maximize = await renderToString(
    h(ICONS.maximize.component, { class: "ico sm", "aria-hidden": "true" }),
  );
  const minimize = await renderToString(h(ICONS.minimize.component));
  for (const svg of [maximize, minimize]) {
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /fill="none"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /stroke-width="2"/);
  }
  assert.match(maximize, /class="ico sm"/);
  assert.match(maximize, /aria-hidden="true"/);
  assert.match(maximize, /d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7"/);
  assert.match(minimize, /d="M4 14h6v6M3 21l7-7M20 10h-6V4M14 10l7-7"/);
  const paths = await Promise.all(
    [ICONS.maximize, ICONS.minimize, ICONS.panel, ICONS.panelClose].map(async ({ component }) => {
      const svg = await renderToString(h(component));
      return svg.match(/<path[^>]*d="([^"]+)"/)?.[1];
    }),
  );
  assert.equal(new Set(paths).size, 4);
});
