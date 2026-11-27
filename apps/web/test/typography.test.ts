import assert from "node:assert/strict";
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
