import { computed, onScopeDispose, ref } from "vue";
import {
  FONT_KEY,
  fontStack,
  PALETTE_IDS,
  type PaletteSwatch,
  parsePalette,
  type ResolvedTheme,
  readTextSize,
  resolveTheme,
  TEXT_SIZE,
  TEXT_SIZE_KEY,
  THEME_PALETTES,
  type ThemePalette,
  type ThemePreference,
} from "./typography.ts";

export {
  PALETTE_IDS,
  type PaletteSwatch,
  parsePalette,
  type ResolvedTheme,
  resolveTheme,
  THEME_PALETTES,
  type ThemePalette,
  type ThemePreference,
};

const THEME_KEY = "eevee.theme";
const PALETTE_KEY = "eevee.palette";

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function loadPreference(): ThemePreference {
  if (!hasDom()) return "system";
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function loadPalette(): ThemePalette {
  if (!hasDom()) return "default";
  return parsePalette(localStorage.getItem(PALETTE_KEY));
}

function systemTheme(): ResolvedTheme {
  if (!hasDom()) return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Suppress CSS transitions for a single paint frame while theme tokens swap. */
function withoutTransitions(fn: () => void): void {
  if (!hasDom()) {
    fn();
    return;
  }
  const el = document.documentElement;
  el.classList.add("no-transitions");
  fn();
  void el.offsetHeight;
  requestAnimationFrame(() => {
    el.classList.remove("no-transitions");
  });
}

function applyAppearance(pref: ThemePreference, pal: ThemePalette): ResolvedTheme {
  const resolved = resolveTheme(pref, systemTheme());
  if (hasDom()) {
    document.documentElement.dataset.theme = resolved;
    if (pal === "default") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = pal;
  }
  return resolved;
}

const preference = ref<ThemePreference>(loadPreference());
const palette = ref<ThemePalette>(loadPalette());
const system = ref<ResolvedTheme>(systemTheme());

export function useTheme() {
  if (hasDom()) {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => {
      system.value = media.matches ? "dark" : "light";
      if (preference.value === "system") {
        withoutTransitions(() => applyAppearance("system", palette.value));
      }
    };
    media.addEventListener("change", onMedia);
    onScopeDispose(() => media.removeEventListener("change", onMedia));
    applyAppearance(preference.value, palette.value);
  }

  const resolved = computed<ResolvedTheme>(() =>
    preference.value === "system" ? system.value : preference.value,
  );

  function setTheme(next: ThemePreference): void {
    preference.value = next;
    if (hasDom()) localStorage.setItem(THEME_KEY, next);
    withoutTransitions(() => applyAppearance(next, palette.value));
  }

  function setPalette(next: ThemePalette): void {
    palette.value = next;
    if (hasDom()) {
      if (next === "default") localStorage.removeItem(PALETTE_KEY);
      else localStorage.setItem(PALETTE_KEY, next);
    }
    withoutTransitions(() => applyAppearance(preference.value, next));
  }

  function toggleTheme(): void {
    setTheme(resolved.value === "dark" ? "light" : "dark");
  }

  return { preference, palette, resolved, setTheme, setPalette, toggleTheme };
}

const textSize = ref(
  readTextSize(hasDom() ? localStorage.getItem(TEXT_SIZE_KEY) : null) ?? TEXT_SIZE.default,
);
const font = ref(hasDom() ? (localStorage.getItem(FONT_KEY) ?? "") : "");

/** The root size every type role, icon and geometry token scales from, ahead of the bundled font. */
function applyTypography(): void {
  if (!hasDom()) return;
  const root = document.documentElement.style;
  root.setProperty("--ev-ui", `${textSize.value}px`);
  root.setProperty("--ev-scale", String(textSize.value / TEXT_SIZE.default));
  const stack = fontStack(font.value);
  if (stack === undefined) root.removeProperty("--ev-font");
  else root.setProperty("--ev-font", stack);
}

applyTypography();

export function useTypography() {
  function setTextSize(next: number): void {
    textSize.value = next;
    if (hasDom()) localStorage.setItem(TEXT_SIZE_KEY, String(next));
    applyTypography();
  }

  function setFont(next: string): void {
    font.value = next;
    if (hasDom()) {
      if (next.trim() === "") localStorage.removeItem(FONT_KEY);
      else localStorage.setItem(FONT_KEY, next);
    }
    applyTypography();
  }

  return { size: textSize, font, setTextSize, setFont };
}
