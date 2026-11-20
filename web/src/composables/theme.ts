import { computed, onScopeDispose, ref } from "vue";
import {
  FONT_KEY,
  fontStack,
  type ResolvedTheme,
  readTextSize,
  resolveTheme,
  TEXT_SIZE,
  TEXT_SIZE_KEY,
  type ThemePreference,
} from "../lib/typography.ts";

export { type ResolvedTheme, resolveTheme, type ThemePreference };

const THEME_KEY = "eevee.theme";

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function loadPreference(): ThemePreference {
  if (!hasDom()) return "system";
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
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

function applyAppearance(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref, systemTheme());
  if (hasDom()) {
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

const preference = ref<ThemePreference>(loadPreference());
const system = ref<ResolvedTheme>(systemTheme());

export function useTheme() {
  if (hasDom()) {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => {
      system.value = media.matches ? "dark" : "light";
      if (preference.value === "system") {
        withoutTransitions(() => applyAppearance("system"));
      }
    };
    media.addEventListener("change", onMedia);
    onScopeDispose(() => media.removeEventListener("change", onMedia));
    applyAppearance(preference.value);
  }

  const resolved = computed<ResolvedTheme>(() =>
    preference.value === "system" ? system.value : preference.value,
  );

  function setTheme(next: ThemePreference): void {
    preference.value = next;
    if (hasDom()) localStorage.setItem(THEME_KEY, next);
    withoutTransitions(() => applyAppearance(next));
  }

  function toggleTheme(): void {
    setTheme(resolved.value === "dark" ? "light" : "dark");
  }

  return { preference, resolved, setTheme, toggleTheme };
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
