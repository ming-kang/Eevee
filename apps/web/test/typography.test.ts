import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_THEME_PRESET,
  parseThemePreference,
  parseThemePreset,
  readStoredTheme,
  THEME_PRESETS,
} from "../src/lib/theme.ts";
import {
  CODE_SIZE_BOUNDS,
  clampSize,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_PROSE_FONT,
  parseBoundedSize,
  parseChatWidth,
  parseProseFont,
  readTypographySettings,
  UI_SIZE_BOUNDS,
} from "../src/lib/typography.ts";

test("parseBoundedSize and clampSize enforce typography bounds and defaults", () => {
  assert.equal(UI_SIZE_BOUNDS.default, 17);
  assert.equal(CODE_SIZE_BOUNDS.default, 15);
  assert.equal(parseBoundedSize("14", UI_SIZE_BOUNDS), 14);
  assert.equal(parseBoundedSize("22", UI_SIZE_BOUNDS), 22);
  assert.equal(parseBoundedSize("99", UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.default);
  assert.equal(parseBoundedSize("abc", CODE_SIZE_BOUNDS), CODE_SIZE_BOUNDS.default);
  assert.equal(parseBoundedSize(null, CODE_SIZE_BOUNDS), CODE_SIZE_BOUNDS.default);

  assert.equal(clampSize(8, UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.min);
  assert.equal(clampSize(30, UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.max);
  assert.equal(clampSize(15.4, CODE_SIZE_BOUNDS), 15);
});

test("readTypographySettings reads stored sizes, width, and prose font safely", () => {
  const map = new Map<string, string>([
    ["eevee-ui-size", "18"],
    ["eevee-code-size", "12"],
    ["eevee-chat-width", "wide"],
    ["eevee-prose-font", "sans"],
  ]);
  assert.deepEqual(readTypographySettings({ getItem: (key) => map.get(key) ?? null }), {
    uiSize: 18,
    codeSize: 12,
    chatWidth: "wide",
    proseFont: "sans",
  });
  assert.equal(parseChatWidth("unknown"), DEFAULT_CHAT_WIDTH);
  assert.equal(parseProseFont("unknown"), DEFAULT_PROSE_FONT);
});

test("theme preset parsing and stored preference fallback cleanly", () => {
  assert.equal(DEFAULT_THEME_PRESET, "paper");
  assert.equal(THEME_PRESETS.length, 4);
  assert.equal(parseThemePreference("dark"), "dark");
  assert.equal(parseThemePreference("invalid"), "system");
  assert.equal(parseThemePreset("slate"), "slate");
  assert.equal(parseThemePreset("lagoon"), "lagoon");
  assert.equal(parseThemePreset("unknown"), "paper");

  const map = new Map<string, string>([
    ["eevee-theme", "light"],
    ["eevee-theme-preset", "graphite"],
  ]);
  assert.deepEqual(readStoredTheme({ getItem: (key) => map.get(key) ?? null }), {
    preference: "light",
    preset: "graphite",
  });
});

function parseOklch(color: string): { readonly l: number; readonly c: number; readonly h: number } {
  const match = /^oklch\(([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\)$/.exec(color);
  assert.ok(match?.[1] && match[2] && match[3], `Expected oklch(L% C H) in "${color}"`);
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

test("theme presets stay distinct in light and dark modes and synced with elanor.css", () => {
  const elanorCss = readFileSync(new URL("../src/styles/elanor.css", import.meta.url), "utf8");
  const settingsCss = readFileSync(new URL("../src/styles/settings.css", import.meta.url), "utf8");

  assert.match(elanorCss, /--ev-code-bg:/);
  assert.ok(settingsCss.includes("var(--ev-preview-light-bg)"));
  assert.ok(settingsCss.includes("var(--ev-preview-dark-bg)"));

  const lightBgs = new Set<string>();
  const darkBgs = new Set<string>();
  const coloredAccentHues: number[] = [];

  for (const preset of THEME_PRESETS) {
    const [lightBg, lightSidebar, lightSurface, lightFg, lightAccent] = preset.swatches.light;
    const [darkBg, darkSidebar, darkSurface, darkFg, darkAccent] = preset.swatches.dark;
    lightBgs.add(lightBg);
    darkBgs.add(darkBg);

    const parsedAccent = parseOklch(lightAccent);
    if (parsedAccent.c > 0) coloredAccentHues.push(parsedAccent.h);

    const darkBgL = parseOklch(darkBg).l;
    const darkSidebarL = parseOklch(darkSidebar).l;
    const darkSurfaceL = parseOklch(darkSurface).l;
    const darkFgL = parseOklch(darkFg).l;

    assert.ok(darkSidebarL >= 23, `${preset.id} dark sidebar L (${darkSidebarL}) should be >= 23%`);
    assert.ok(darkBgL >= 26, `${preset.id} dark bg L (${darkBgL}) should be >= 26%`);
    assert.ok(darkSurfaceL >= 30, `${preset.id} dark surface L (${darkSurfaceL}) should be >= 30%`);
    assert.ok(darkBgL - darkSidebarL >= 3, `${preset.id} dark bg-sidebar step should be >= 3%`);
    assert.ok(darkSurfaceL - darkBgL >= 3.5, `${preset.id} dark surface-bg step should be >= 3.5%`);
    assert.ok(darkFgL <= 92, `${preset.id} dark fg L (${darkFgL}) should avoid harsh pure white`);

    for (const [token, value] of [
      ["--ev-bg", lightBg],
      ["--ev-sidebar", lightSidebar],
      ["--ev-surface", lightSurface],
      ["--ev-fg", lightFg],
      ["--ev-accent", lightAccent],
      ["--ev-bg", darkBg],
      ["--ev-sidebar", darkSidebar],
      ["--ev-surface", darkSurface],
      ["--ev-fg", darkFg],
      ["--ev-accent", darkAccent],
      ["--ev-preview-light-bg", lightBg],
      ["--ev-preview-dark-bg", darkBg],
    ] as const) {
      assert.ok(elanorCss.includes(`${token}: ${value};`), `${preset.id} ${token} out of sync`);
    }
  }

  assert.equal(lightBgs.size, THEME_PRESETS.length, "each preset should have a distinct light bg");
  assert.equal(darkBgs.size, THEME_PRESETS.length, "each preset should have a distinct dark bg");
  assert.equal(coloredAccentHues.length, 3);
  for (let i = 0; i < coloredAccentHues.length; i++) {
    for (let j = i + 1; j < coloredAccentHues.length; j++) {
      const a = coloredAccentHues[i];
      const b = coloredAccentHues[j];
      assert.ok(a !== undefined && b !== undefined);
      const diff = Math.abs(a - b);
      const angularDiff = Math.min(diff, 360 - diff);
      assert.ok(angularDiff >= 60, `accent hues ${a} and ${b} should be separated by >= 60 deg`);
    }
  }
});

test("ModePreviewCard uses visual-only cards ordered light, system, dark with clean diagonal split", () => {
  const generalTab = readFileSync(
    new URL("../src/components/settings/GeneralTab.tsx", import.meta.url),
    "utf8",
  );
  const settingsCss = readFileSync(new URL("../src/styles/settings.css", import.meta.url), "utf8");
  const start = generalTab.indexOf("function ModePreviewCard(");
  const end = generalTab.indexOf("function PresetCard(");
  assert.ok(start >= 0 && end > start, "ModePreviewCard definition not found");

  const body = generalTab.slice(start, end);
  assert.equal(body.includes("ev-mode-card-label"), false);
  assert.equal(body.includes("ev-sr-only"), false);
  assert.ok(body.includes("aria-label={label}"));
  assert.ok(body.includes("<EvTooltip content={label}"));
  assert.ok(generalTab.includes('(["light", "system", "dark"] as const)'));

  const systemRuleStart = settingsCss.indexOf(".ev-mode-card-system {");
  const systemRuleEnd = settingsCss.indexOf("}", systemRuleStart);
  assert.ok(systemRuleStart >= 0 && systemRuleEnd > systemRuleStart);
  const systemRule = settingsCss.slice(systemRuleStart, systemRuleEnd);
  assert.ok(settingsCss.includes("background-clip: padding-box;"));
  assert.ok(systemRule.includes("to bottom right"));
  assert.ok(systemRule.includes("background-origin: border-box;"));
  assert.ok(systemRule.includes("background-repeat: no-repeat;"));
});
