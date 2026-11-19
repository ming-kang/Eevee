import assert from "node:assert/strict";
import test from "node:test";
import { quoteMarkdown } from "./quote.ts";

test("every line is prefixed, empty lines become bare >", () => {
  assert.equal(quoteMarkdown("one\n\nthree"), "> one\n>\n> three\n\n");
});

test("CRLF normalises and trailing blank lines drop", () => {
  assert.equal(quoteMarkdown("a\r\nb\r\n\r\n"), "> a\n> b\n\n");
  assert.equal(quoteMarkdown("a\n  \n\n"), "> a\n\n");
});

test("a single line still ends with a blank line for the reply", () => {
  assert.equal(quoteMarkdown("just this"), "> just this\n\n");
});
