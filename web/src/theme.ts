import { computed, onScopeDispose, ref } from "vue";
import { FONT_KEY, fontStack, readTextSize, TEXT_SIZE, TEXT_SIZE_KEY } from "./typography.ts";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const THEME_KEY = "eevee.theme";

function loadPreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemTheme(): ResolvedTheme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

function applyTheme(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

const preference = ref<ThemePreference>(loadPreference());
const system = ref<ResolvedTheme>(systemTheme());

export function useTheme() {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    system.value = media.matches ? "dark" : "light";
    if (preference.value === "system") applyTheme("system");
  };
  media.addEventListener("change", onMedia);
  onScopeDispose(() => media.removeEventListener("change", onMedia));

  applyTheme(preference.value);

  const resolved = computed<ResolvedTheme>(() =>
    preference.value === "system" ? system.value : preference.value,
  );

  function setTheme(next: ThemePreference): void {
    preference.value = next;
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  function toggleTheme(): void {
    setTheme(resolved.value === "dark" ? "light" : "dark");
  }

  return { preference, resolved, setTheme, toggleTheme };
}

const root = document.documentElement.style;
const textSize = ref(readTextSize(localStorage.getItem(TEXT_SIZE_KEY)) ?? TEXT_SIZE.default);
const font = ref(localStorage.getItem(FONT_KEY) ?? "");

/** The root size every type role and icon scales from, and the font ahead of the bundled one. */
function applyTypography(): void {
  root.setProperty("--ev-ui", `${textSize.value}px`);
  const stack = fontStack(font.value);
  if (stack === undefined) root.removeProperty("--ev-font");
  else root.setProperty("--ev-font", stack);
}

// Before the app mounts: the page has no text until then, so the first frame with words is right.
applyTypography();

export function useTypography() {
  function setTextSize(next: number): void {
    textSize.value = next;
    localStorage.setItem(TEXT_SIZE_KEY, String(next));
    applyTypography();
  }

  function setFont(next: string): void {
    font.value = next;
    if (next.trim() === "") localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, next);
    applyTypography();
  }

  return { size: textSize, font, setTextSize, setFont };
}
