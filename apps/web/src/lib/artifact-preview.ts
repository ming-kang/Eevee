export type PreviewArtifactKind = "html" | "svg" | "mermaid";

export type PreviewArtifact = {
  readonly kind: PreviewArtifactKind;
  readonly code: string;
  readonly language: string;
  readonly title: string;
};

export function detectPreviewKind(
  lang: string | undefined,
  code: string,
): PreviewArtifactKind | undefined {
  const raw = (lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (raw === "svg" || raw === "image/svg+xml") return "svg";
  if (raw === "html" || raw === "htm") return "html";
  if (raw === "mermaid" || raw === "mmd") return "mermaid";
  const trimmed = code.trim();
  if (!raw && trimmed.startsWith("<svg") && trimmed.includes("</svg>")) return "svg";
  return undefined;
}

export type HostThemeColors = {
  readonly scheme: "light" | "dark";
  readonly bg: string;
  readonly surface: string;
  readonly fg: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly fontSans: string;
  readonly fontMono: string;
};

export function readHostThemeColors(): HostThemeColors {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      scheme: "light",
      bg: "#ffffff",
      surface: "#f7f6f3",
      fg: "#1f1d1a",
      muted: "#6d685f",
      border: "#e3dfd6",
      accent: "#3b82f6",
      fontSans: "system-ui, sans-serif",
      fontMono: "monospace",
    };
  }
  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  const scheme = root.dataset.colorScheme === "dark" ? "dark" : "light";
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    scheme,
    bg: get("--ev-bg", scheme === "dark" ? "#282522" : "#f8f6f3"),
    surface: get("--ev-surface", scheme === "dark" ? "#322f2b" : "#fefdfc"),
    fg: get("--ev-fg", scheme === "dark" ? "#e3e1dc" : "#1c1915"),
    muted: get("--ev-fg-muted", scheme === "dark" ? "#bbb8b4" : "#56524d"),
    border: get("--ev-border", scheme === "dark" ? "#47433e" : "#dedad0"),
    accent: get("--ev-accent", scheme === "dark" ? "#e1996d" : "#a35431"),
    fontSans: get("--primitive-font-family-sans-serif", "system-ui, sans-serif"),
    fontMono: get("--primitive-font-family-mono", "ui-monospace, monospace"),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildThemeCss(theme: HostThemeColors): string {
  return `
:root {
  color-scheme: ${theme.scheme};
  --bg: ${theme.bg};
  --surface: ${theme.surface};
  --fg: ${theme.fg};
  --muted: ${theme.muted};
  --border: ${theme.border};
  --accent: ${theme.accent};
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--fg);
  font-family: ${theme.fontSans};
  line-height: 1.55;
}
body { padding: 16px; }
svg { max-width: 100%; height: auto; }
`;
}

export function buildArtifactSrcDoc(
  artifact: Pick<PreviewArtifact, "kind" | "code">,
  theme: HostThemeColors,
): string {
  const baseStyle = `<style>${buildThemeCss(theme)}</style>`;

  if (artifact.kind === "svg") {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${baseStyle}
<style>
body {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 20px;
}
</style>
</head>
<body>${artifact.code}</body>
</html>`;
  }

  if (artifact.kind === "mermaid") {
    const escaped = escapeHtml(artifact.code);
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${baseStyle}
<style>
.diagram-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 32px);
  gap: 12px;
}
.mermaid-fallback {
  width: 100%;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-family: ${theme.fontMono};
  font-size: 13px;
  white-space: pre-wrap;
  overflow: auto;
}
.mermaid-note {
  font-size: 12px;
  color: var(--muted);
}
</style>
</head>
<body>
<div class="diagram-wrap">
  <div id="mermaid-target" class="mermaid">${escaped}</div>
  <div id="mermaid-note" class="mermaid-note" hidden></div>
</div>
<script type="module">
const source = ${JSON.stringify(artifact.code)};
const target = document.getElementById("mermaid-target");
const note = document.getElementById("mermaid-note");
try {
  const mod = await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
  mod.default.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: ${JSON.stringify(theme.scheme === "dark" ? "dark" : "neutral")},
  });
  const { svg } = await mod.default.render("ev-mermaid-svg", source);
  target.innerHTML = svg;
} catch {
  target.className = "mermaid-fallback";
  target.textContent = source;
  note.hidden = false;
  note.textContent = "Mermaid CDN unavailable offline — showing diagram source.";
}
</script>
</body>
</html>`;
  }

  const trimmed = artifact.code.trim();
  const hasDocTag = /<!doctype|<html[\s>]/i.test(trimmed);
  if (hasDocTag) {
    if (/<head[\s>]/i.test(trimmed)) {
      return trimmed.replace(/<head([^>]*)>/i, `<head$1>${baseStyle}`);
    }
    return `${baseStyle}${trimmed}`;
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${baseStyle}
</head>
<body>${artifact.code}</body>
</html>`;
}
