import { computed, onScopeDispose, ref } from "vue";
import { parseTextSize, TEXT_SIZE_KEY, type TextSize } from "./text-size.ts";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "eevee.theme";

function loadPreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemTheme(): ResolvedTheme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

export function applyTheme(pref: ThemePreference): ResolvedTheme {
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

/** Sets the root interface size that every type role and icon scales from; `index.html` does the
 * same before first paint. */
function applyTextSize(size: TextSize): void {
  document.documentElement.style.setProperty("--ev-ui", `${size}px`);
}

const textSize = ref<TextSize>(parseTextSize(localStorage.getItem(TEXT_SIZE_KEY)));

export function useTextSize() {
  function setTextSize(next: TextSize): void {
    textSize.value = next;
    localStorage.setItem(TEXT_SIZE_KEY, String(next));
    applyTextSize(next);
  }

  return { size: textSize, setTextSize };
}
