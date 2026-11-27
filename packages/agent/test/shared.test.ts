import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearConfigValueCache,
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  isConfigValueConfigured,
  resolveConfigValue,
  resolveHeaders,
  resolveHeadersStrict,
} from "../src/shared/config-value.ts";
import { withFileLock, writeFileAtomic } from "../src/shared/file-lock.ts";
import {
  errorCode,
  errorMessage,
  isEnoent,
  isRecord,
  isStringRecord,
} from "../src/shared/guards.ts";
import { createIgnoreRule, isIgnoredByRules } from "../src/shared/ignore.ts";
import { stripBom, stripJsonComments } from "../src/shared/json.ts";
import { LockedJsonMapStore } from "../src/shared/json-map-store.ts";
import { expandHome } from "../src/shared/paths.ts";
import {
  alignUtf8End,
  alignUtf8Start,
  formatSize,
  truncateHead,
  truncateTail,
  utf8HeadBytes,
  utf8HeadClip,
  utf8TailClip,
} from "../src/shared/truncate.ts";
import { escapeXml, escapeXmlAttr } from "../src/shared/xml.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-shared-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stripBom removes a leading BOM and leaves other content untouched", () => {
  assert.equal(stripBom("﻿{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
  assert.equal(stripBom(""), "");
  assert.equal(stripBom("a﻿b"), "a﻿b");
});

test("stripJsonComments strips line and block comments outside strings", () => {
  const input = [
    "{",
    "  // line comment",
    '  "a": 1, /* inline */ "b": "http://x//y",',
    "  /* multi",
    "     line */",
    '  "c": "/* not a comment */"',
    "}",
  ].join("\n");
  const stripped = stripJsonComments(input);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b, "http://x//y");
  assert.equal(parsed.c, "/* not a comment */");
});

test("stripJsonComments keeps escaped quotes inside strings and preserves block comment newlines", () => {
  const input = '{\n"a": "x\\"//y",\n/* one\n two\n three */\n"b": 2\n}';
  const stripped = stripJsonComments(input);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  assert.equal(parsed.a, 'x"//y');
  assert.equal(parsed.b, 2);
  const newlinesBefore = input.split("\n").length;
  const newlinesAfter = stripped.split("\n").length;
  assert.equal(newlinesAfter, newlinesBefore);
});

test("resolveConfigValue resolves literals, $VAR, and braced $VAR forms from the injected env", () => {
  const env = { HOST: "example.com", PORT: "8080" };
  assert.equal(resolveConfigValue("literal", env), "literal");
  assert.equal(resolveConfigValue("https://$HOST/api", env), "https://example.com/api");
  assert.equal(resolveConfigValue(`https://\${HOST}:\${PORT}`, env), "https://example.com:8080");
  assert.equal(resolveConfigValue("$MISSING", env), undefined);
  assert.equal(resolveConfigValue("pre$MISSINGpost", env), undefined);
});

test("resolveConfigValue treats empty env values as missing and escapes $$ and $!", () => {
  const env = { EMPTY: "", SET: "x" };
  assert.equal(resolveConfigValue("$EMPTY", env), undefined);
  assert.equal(resolveConfigValue("$$SET", env), "$SET");
  assert.equal(resolveConfigValue("$!cmd", env), "!cmd");
  assert.equal(resolveConfigValue("100$$", env), "100$");
  assert.equal(resolveConfigValue("$SET", env), "x");
});

test("resolveConfigValue leaves malformed dollar sequences literal", () => {
  assert.equal(resolveConfigValue("$", {}), "$");
  assert.equal(resolveConfigValue(`\${unclosed`, {}), `\${unclosed`);
  assert.equal(resolveConfigValue(`\${not valid name}`, {}), `\${not valid name}`);
  assert.equal(resolveConfigValue("$1abc", {}), "$1abc");
});

test("isCommandConfigValue and getConfigValueEnvVarNames classify values", () => {
  assert.equal(isCommandConfigValue("!echo hi"), true);
  assert.equal(isCommandConfigValue("$!echo hi"), false);
  assert.deepEqual(getConfigValueEnvVarNames(`https://$HOST:\${PORT}/$HOST`), ["HOST", "PORT"]);
  assert.deepEqual(getConfigValueEnvVarNames("!echo hi"), []);
});

test("isConfigValueConfigured reports whether every reference resolves", () => {
  const env = { SET: "x" };
  assert.equal(isConfigValueConfigured("literal", env), true);
  assert.equal(isConfigValueConfigured("$SET", env), true);
  assert.equal(isConfigValueConfigured("$MISSING", env), false);
  assert.equal(isConfigValueConfigured("!echo hi", env), true);
  assert.equal(isConfigValueConfigured("!", env), false);
});

test("resolveConfigValue executes !commands and caches the output", () => {
  clearConfigValueCache();
  assert.equal(resolveConfigValue("!echo eevee-test-output"), "eevee-test-output");
  assert.equal(resolveConfigValue("!definitely-not-a-real-command-eevee"), undefined);
});

test("resolveHeaders drops entries whose value does not resolve", () => {
  const env = { TOKEN: "abc" };
  assert.deepEqual(resolveHeaders({ Authorization: "Bearer $TOKEN", "X-Skip": "$MISSING" }, env), {
    Authorization: "Bearer abc",
  });
  assert.equal(resolveHeaders({ "X-Skip": "$MISSING" }, env), undefined);
  assert.equal(resolveHeaders(undefined, env), undefined);
});

test("resolveConfigValue can bypass the !command cache for models.json values", () => {
  clearConfigValueCache();
  const command = '!node -e "console.log(process.hrtime.bigint().toString())"';
  const cachedFirst = resolveConfigValue(command, {});
  const cachedSecond = resolveConfigValue(command, {});
  assert.equal(cachedFirst, cachedSecond);
  const freshFirst = resolveConfigValue(command, {}, { cacheCommands: false });
  const freshSecond = resolveConfigValue(command, {}, { cacheCommands: false });
  assert.ok(freshFirst);
  assert.ok(freshSecond);
  assert.notEqual(freshFirst, freshSecond);
});

test("resolveHeadersStrict names unresolved headers and environment variables", () => {
  assert.deepEqual(resolveHeadersStrict({ Authorization: "Bearer $TOKEN" }, { TOKEN: "abc" }), {
    Authorization: "Bearer abc",
  });
  assert.throws(
    () => resolveHeadersStrict({ "X-Token": "$FIRST-$SECOND" }, { FIRST: "one" }),
    /X-Token.*SECOND/,
  );
  assert.throws(
    () => resolveHeadersStrict({ "X-Command": "!definitely-not-a-real-command-eevee" }, {}),
    /X-Command.*!command/,
  );
});

test("formatSize formats bytes, kilobytes, and megabytes", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(1023), "1023B");
  assert.equal(formatSize(1024), "1.0KB");
  assert.equal(formatSize(50 * 1024), "50.0KB");
  assert.equal(formatSize(1024 * 1024), "1.0MB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0MB");
});

test("truncateHead keeps content within both limits untouched", () => {
  const result = truncateHead("a\nb\nc", { maxLines: 10, maxBytes: 100 });
  assert.equal(result.content, "a\nb\nc");
  assert.equal(result.truncated, false);
  assert.equal(result.truncatedBy, null);
  assert.equal(result.totalLines, 3);
});

test("truncateHead truncates by lines and by bytes", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
  const byLines = truncateHead(lines, { maxLines: 3, maxBytes: 10_000 });
  assert.equal(byLines.content, "line0\nline1\nline2");
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.truncatedBy, "lines");
  assert.equal(byLines.outputLines, 3);
  assert.equal(byLines.totalLines, 10);

  const byBytes = truncateHead(lines, { maxLines: 100, maxBytes: 12 });
  assert.equal(byBytes.truncatedBy, "bytes");
  assert.equal(byBytes.content, "line0\nline1");
  assert.ok(byBytes.outputBytes <= 12);
});

test("truncateTail keeps the tail within line and byte limits", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
  const byLines = truncateTail(lines, { maxLines: 2, maxBytes: 10_000 });
  assert.equal(byLines.content, "line8\nline9");
  assert.equal(byLines.truncatedBy, "lines");

  const byBytes = truncateTail(lines, { maxLines: 100, maxBytes: 12 });
  assert.equal(byBytes.truncatedBy, "bytes");
  assert.equal(byBytes.content, "line8\nline9");
});

test("truncateTail never splits a multibyte character in a partial line", () => {
  const content = "x".repeat(100) + "世".repeat(20);
  const result = truncateTail(content, { maxLines: 1, maxBytes: 10 });
  assert.equal(result.truncated, true);
  for (const ch of result.content) {
    assert.notEqual(ch, "�");
  }
  assert.ok(result.outputBytes <= 10 || result.content.length > 0);
});

test("writeFileAtomic writes content and replaces existing files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "nested", "data.json");
    await writeFileAtomic(file, '{"a":1}');
    assert.equal(await readFile(file, "utf8"), '{"a":1}');
    await writeFileAtomic(file, '{"a":2}');
    assert.equal(await readFile(file, "utf8"), '{"a":2}');
  });
});

test("withFileLock serializes overlapping operations in-process", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "locked.txt");
    const order: string[] = [];
    const first = withFileLock(file, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("first:end");
    });
    const second = withFileLock(file, async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
    await assert.rejects(stat(`${file}.lock`));
  });
});

test("withFileLock breaks a stale lock directory left by a dead process", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "stale.txt");
    await mkdir(`${file}.lock`, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, past, past);
    const result = await withFileLock(file, async () => "acquired");
    assert.equal(result, "acquired");
    await assert.rejects(stat(`${file}.lock`));
  });
});

test("guards validate plain records, string records, error messages, and ENOENT errors", () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([1, 2]), false);
  assert.equal(isRecord("str"), false);

  assert.equal(isStringRecord({ a: "x", b: "y" }), true);
  assert.equal(isStringRecord({ a: "x", b: 1 }), false);
  assert.equal(isStringRecord(null), false);

  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(42), "42");

  const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
  const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.equal(errorCode(enoent), "ENOENT");
  assert.equal(errorCode(new Error("no code")), undefined);
  assert.equal(isEnoent(enoent), true);
  assert.equal(isEnoent(eacces), false);
  assert.equal(isEnoent("ENOENT"), false);
});

test("expandHome resolves ~ and ~/ across platforms and leaves other paths untouched", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/sub/file"), join(homedir(), "sub/file"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("~other/file"), "~other/file");
  if (process.platform === "win32") {
    assert.equal(expandHome("~\\sub\\file"), join(homedir(), "sub\\file"));
  } else {
    assert.equal(expandHome("~\\sub\\file"), "~\\sub\\file");
  }
});

test("escapeXml and escapeXmlAttr escape special XML characters", () => {
  assert.equal(escapeXml('a & <b> "c"'), 'a &amp; &lt;b&gt; "c"');
  assert.equal(escapeXmlAttr('a & <b> "c"'), "a &amp; &lt;b&gt; &quot;c&quot;");
});

test("createIgnoreRule and isIgnoredByRules respect root, directory, and nested negation rules", () => {
  const rules = [createIgnoreRule("", "*.log\ndist/\n"), createIgnoreRule("sub", "!keep.log\n")];
  assert.equal(isIgnoredByRules(rules, "root.log", false), true);
  assert.equal(isIgnoredByRules(rules, "dist", true), true);
  assert.equal(isIgnoredByRules(rules, "dist/bundle.js", false), true);
  assert.equal(isIgnoredByRules(rules, "sub/drop.log", false), true);
  assert.equal(isIgnoredByRules(rules, "sub/keep.log", false), false);
  assert.equal(isIgnoredByRules(rules, "src/index.ts", false), false);
});

test("UTF-8 alignment and clipping helpers never split multibyte sequences", () => {
  const sample = "a€😀b";
  const bytes = Buffer.from(sample, "utf8");
  assert.equal(bytes.length, 9);

  assert.equal(alignUtf8Start(bytes, -2), 0);
  assert.equal(alignUtf8Start(bytes, 1), 1);
  assert.equal(alignUtf8Start(bytes, 2), 4);
  assert.equal(alignUtf8Start(bytes, 3), 4);
  assert.equal(alignUtf8Start(bytes, 5), 8);

  assert.equal(alignUtf8End(bytes, 0), 0);
  assert.equal(alignUtf8End(bytes, 1), 1);
  assert.equal(alignUtf8End(bytes, 2), 1);
  assert.equal(alignUtf8End(bytes, 3), 1);
  assert.equal(alignUtf8End(bytes, 4), 4);
  assert.equal(alignUtf8End(bytes, 7), 4);
  assert.equal(alignUtf8End(bytes, 8), 8);
  assert.equal(alignUtf8End(bytes, 100), 9);

  assert.equal(utf8HeadClip(sample, 0), "");
  assert.equal(utf8HeadClip(sample, 3), "a");
  assert.equal(utf8HeadClip(sample, 4), "a€");
  assert.equal(utf8HeadClip(sample, 7), "a€");
  assert.equal(utf8HeadClip(sample, 8), "a€😀");
  assert.equal(utf8HeadClip(sample, 9), sample);
  assert.equal(utf8HeadBytes(sample, 7).toString("utf8"), "a€");

  assert.equal(utf8TailClip(sample, 0), "");
  assert.equal(utf8TailClip(sample, 1), "b");
  assert.equal(utf8TailClip(sample, 4), "b");
  assert.equal(utf8TailClip(sample, 5), "😀b");
  assert.equal(utf8TailClip(sample, 7), "😀b");
  assert.equal(utf8TailClip(sample, 8), "€😀b");
  assert.equal(utf8TailClip(sample, 9), sample);
});

test("LockedJsonMapStore reads JSONC/BOM, enforces validation and 0o600 mode, and serializes writes", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "map.json");
    const store = new LockedJsonMapStore<{ readonly value: number }>({
      filePath,
      invalidRootMessage: "Root must be object",
      formatParseError: (error) => new Error(`Parse failure: ${errorMessage(error)}`),
      wrapError: (error) => new Error(`Wrapped: ${errorMessage(error)}`),
      validateEntry: (key, entry) => {
        if (!isRecord(entry) || typeof entry.value !== "number") {
          throw new Error(`Bad entry ${key}`);
        }
        return { value: entry.value };
      },
    });

    assert.deepEqual(await store.readAll(), {});
    assert.equal(await store.get("missing"), undefined);
    assert.equal(await store.delete("missing"), false);

    await Promise.all([
      store.set("a", { value: 1 }),
      store.set("b", { value: 2 }),
      store.modify("c", (current) => ({ value: (current?.value ?? 0) + 3 })),
    ]);

    assert.deepEqual(await store.readAll(), {
      a: { value: 1 },
      b: { value: 2 },
      c: { value: 3 },
    });

    if (process.platform !== "win32") {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }

    const unchanged = await store.modify("a", () => undefined);
    assert.deepEqual(unchanged, { value: 1 });
    assert.equal(await store.delete("b"), true);
    assert.equal(await store.get("b"), undefined);

    await writeFile(filePath, '\ufeff{ // comment\n  "k": { "value": 9 }\n}');
    assert.deepEqual(await store.get("k"), { value: 9 });

    await writeFile(filePath, "{ bad json");
    await assert.rejects(store.readAll(), /Wrapped: Parse failure:/);

    await writeFile(filePath, "[]");
    await assert.rejects(store.readAll(), /Wrapped: Root must be object/);

    await writeFile(filePath, JSON.stringify({ bad: { value: "nope" } }));
    await assert.rejects(store.readAll(), /Wrapped: Bad entry bad/);
  });
});
