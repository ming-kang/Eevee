import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPastedTextAttachment,
  LONG_PASTE_CHAR_THRESHOLD,
  shouldConvertPasteToAttachment,
} from "../src/lib/attachments.ts";
import { resolveProviderBrand } from "../src/lib/provider-brand.ts";

describe("long paste attachment conversion", () => {
  it("converts only pastes meeting the character threshold", () => {
    assert.equal(shouldConvertPasteToAttachment("short text"), false);
    assert.equal(shouldConvertPasteToAttachment("a".repeat(LONG_PASTE_CHAR_THRESHOLD - 1)), false);
    assert.equal(shouldConvertPasteToAttachment("a".repeat(LONG_PASTE_CHAR_THRESHOLD)), true);
  });

  it("creates deduplicated .txt draft attachments with preserved pastedText and base64 payload", () => {
    const content = `你好世界\n${"x".repeat(LONG_PASTE_CHAR_THRESHOLD)}`;
    const first = createPastedTextAttachment(content, []);
    assert.ok(first.attachment);
    assert.equal(first.issue, undefined);
    assert.equal(first.attachment.name, "pasted-text.txt");
    assert.equal(first.attachment.mimeType, "text/plain");
    assert.equal(first.attachment.pastedText, content);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(first.attachment.data), (c) => c.charCodeAt(0)),
    );
    assert.equal(decoded, content);

    const second = createPastedTextAttachment(content, [first.attachment]);
    assert.ok(second.attachment);
    assert.equal(second.attachment.name, "pasted-text-2.txt");
  });
});

describe("provider brand resolver", () => {
  it("maps known provider IDs to brand tokens and falls back to generic", () => {
    assert.equal(resolveProviderBrand("anthropic"), "anthropic");
    assert.equal(resolveProviderBrand("openai-codex"), "openai");
    assert.equal(resolveProviderBrand("google-gemini-cli"), "google");
    assert.equal(resolveProviderBrand("deepseek"), "deepseek");
    assert.equal(resolveProviderBrand("openrouter"), "openrouter");
    assert.equal(resolveProviderBrand("my-custom-gw"), "generic");
  });
});
