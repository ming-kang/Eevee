import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArtifactSrcDoc,
  detectPreviewKind,
  type HostThemeColors,
} from "../src/lib/artifact-preview.ts";

const THEME: HostThemeColors = {
  scheme: "dark",
  bg: "#1c1b18",
  surface: "#252420",
  fg: "#efece6",
  muted: "#b4afa5",
  border: "#3b3831",
  accent: "#60a5fa",
  fontSans: "Inter, sans-serif",
  fontMono: "CommitMono, monospace",
};

describe("artifact-preview", () => {
  it("detects html, svg, and mermaid languages and inline svg snippets", () => {
    assert.equal(detectPreviewKind("html", "<div>hi</div>"), "html");
    assert.equal(detectPreviewKind("SVG", "<svg></svg>"), "svg");
    assert.equal(detectPreviewKind("mermaid", "graph TD; A-->B;"), "mermaid");
    assert.equal(detectPreviewKind(undefined, "<svg viewBox='0 0 10 10'></svg>"), "svg");
    assert.equal(detectPreviewKind("typescript", "const x = 1;"), undefined);
  });

  it("injects host CSS theme variables into html, svg, and mermaid srcDoc", () => {
    const htmlDoc = buildArtifactSrcDoc({ kind: "html", code: "<p>Hello</p>" }, THEME);
    assert.ok(htmlDoc.includes("color-scheme: dark"));
    assert.ok(htmlDoc.includes("--bg: #1c1b18"));
    assert.ok(htmlDoc.includes("<p>Hello</p>"));

    const fullHtml = buildArtifactSrcDoc(
      {
        kind: "html",
        code: "<!doctype html><html><head><title>X</title></head><body>Hi</body></html>",
      },
      THEME,
    );
    assert.ok(fullHtml.includes("--accent: #60a5fa"));
    assert.ok(fullHtml.includes("<title>X</title>"));

    const svgDoc = buildArtifactSrcDoc({ kind: "svg", code: "<svg><circle r='5'/></svg>" }, THEME);
    assert.ok(svgDoc.includes("place-items: center"));
    assert.ok(svgDoc.includes("<circle r='5'/>"));

    const mmdDoc = buildArtifactSrcDoc({ kind: "mermaid", code: "graph LR\nA --> B" }, THEME);
    assert.ok(mmdDoc.includes("mermaid"));
    assert.ok(mmdDoc.includes('securityLevel: "strict"'));
    assert.ok(mmdDoc.includes("mermaid-fallback"));
  });
});
