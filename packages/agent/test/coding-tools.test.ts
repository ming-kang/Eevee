import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createCodingToolsExtension,
  createReadonlyToolsExtension,
  findTool,
  grepTool,
  lsTool,
} from "../src/extensions/coding-tools/index.ts";
import { matchGlob, walkFiles } from "../src/extensions/coding-tools/listings.ts";
import { createHarnessFixture, type HarnessFixture } from "./fixture.ts";

function apiFor(env: NodeExecutionEnv): ToolExecutionApi {
  return { env } as unknown as ToolExecutionApi;
}

function outputText(result: unknown): string {
  const output = (result as { output?: { type: string; text?: string }[] }).output;
  assert.ok(Array.isArray(output));
  return output.map((part) => part.text ?? "").join("");
}

async function withEnv(
  fn: (env: NodeExecutionEnv, fixture: HarnessFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createHarnessFixture();
  try {
    await fn(fixture.env, fixture);
  } finally {
    await fixture.cleanup();
  }
}

test("ls lists entries sorted case-insensitively with directory suffixes", async () => {
  await withEnv(async (env) => {
    await writeFile(join(env.cwd, "beta.txt"), "x");
    await writeFile(join(env.cwd, "Alpha.txt"), "x");
    await mkdir(join(env.cwd, "middle"));
    const result = await lsTool.execute({}, apiFor(env), BACKGROUND_CONTEXT);
    const text = outputText(result);
    const lines = text.split("\n");
    assert.deepEqual(lines, ["Alpha.txt", "beta.txt", "middle/"]);
    assert.equal(
      (result as { structuredOutput?: { entries: string[] } }).structuredOutput?.entries.length,
      3,
    );
  });
});

test("ls reports errors with isError and honors the entry limit", async () => {
  await withEnv(async (env) => {
    const missing = await lsTool.execute({ path: "missing-dir" }, apiFor(env), BACKGROUND_CONTEXT);
    assert.equal((missing as { isError?: boolean }).isError, true);
    await writeFile(join(env.cwd, "a.txt"), "");
    await writeFile(join(env.cwd, "b.txt"), "");
    const limited = await lsTool.execute({ limit: 1 }, apiFor(env), BACKGROUND_CONTEXT);
    assert.ok(outputText(limited).includes("1 entries limit reached. Use limit=2 for more"));
    assert.equal(
      (limited as { structuredOutput?: { entryLimitReached?: number } }).structuredOutput
        ?.entryLimitReached,
      1,
    );
  });
});

test("ls marks empty directories", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "empty"));
    const result = await lsTool.execute({ path: "empty" }, apiFor(env), BACKGROUND_CONTEXT);
    assert.ok(outputText(result).includes("(empty directory)"));
  });
});

test("matchGlob matches basenames, full paths, and ** zero-directory crossings", () => {
  assert.equal(matchGlob("*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("*.ts", "src/a.js"), false);
  assert.equal(matchGlob("src/**/*.ts", "src/deep/x.test.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/deep/a.ts"), false);
  assert.equal(matchGlob("./src/a.ts", "src/a.ts"), true);
});

test("find respects .gitignore files and matches at any depth for basename patterns", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "src", "deep"), { recursive: true });
    await mkdir(join(env.cwd, "ignored-dir"), { recursive: true });
    await writeFile(join(env.cwd, ".gitignore"), "ignored-dir/\nsecret.txt\n");
    await writeFile(join(env.cwd, "src", "a.ts"), "");
    await writeFile(join(env.cwd, "src", "deep", "b.ts"), "");
    await writeFile(join(env.cwd, "src", "c.js"), "");
    await writeFile(join(env.cwd, "secret.txt"), "");
    await writeFile(join(env.cwd, "ignored-dir", "d.ts"), "");
    const result = await findTool.execute({ pattern: "*.ts" }, apiFor(env), BACKGROUND_CONTEXT);
    const text = outputText(result);
    assert.ok(text.includes("src/a.ts"));
    assert.ok(text.includes("src/deep/b.ts"));
    assert.ok(!text.includes("c.js"));
    assert.ok(!text.includes("ignored-dir"));
    const secret = await findTool.execute(
      { pattern: "secret.txt" },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    assert.ok(outputText(secret).includes("No files found"));
  });
});

test("walkFiles treats trailing-slash gitignore patterns as directory rules", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "dist"), { recursive: true });
    await mkdir(join(env.cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(env.cwd, ".gitignore"), "dist/\nnode_modules/\n");
    await writeFile(join(env.cwd, "dist", "bundle.js"), "");
    await writeFile(join(env.cwd, "node_modules", "pkg", "index.js"), "");
    await writeFile(join(env.cwd, "visible.txt"), "");
    const listing = await walkFiles(env, ".", BACKGROUND_CONTEXT);
    assert.equal(listing.ok, true);
    if (listing.ok) {
      assert.deepEqual(listing.entries.map((entry) => entry.path).sort(), [
        ".gitignore",
        "visible.txt",
      ]);
    }
  });
});

test("find honors nested .gitignore negations", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "sub"), { recursive: true });
    await writeFile(join(env.cwd, ".gitignore"), "*.log\n");
    await writeFile(join(env.cwd, "sub", ".gitignore"), "!keep.log\n");
    await writeFile(join(env.cwd, "root.log"), "");
    await writeFile(join(env.cwd, "sub", "keep.log"), "");
    await writeFile(join(env.cwd, "sub", "drop.log"), "");
    const result = await findTool.execute({ pattern: "*.log" }, apiFor(env), BACKGROUND_CONTEXT);
    const text = outputText(result);
    assert.ok(!text.includes("root.log"));
    assert.ok(text.includes("sub/keep.log"));
    assert.ok(!text.includes("drop.log"));
  });
});

test("find reports errors with isError and applies the result limit", async () => {
  await withEnv(async (env) => {
    const missing = await findTool.execute(
      { pattern: "*.ts", path: "missing" },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    assert.equal((missing as { isError?: boolean }).isError, true);
    await mkdir(join(env.cwd, "many"), { recursive: true });
    for (const name of ["1.ts", "2.ts", "3.ts"]) {
      await writeFile(join(env.cwd, "many", name), "");
    }
    const limited = await findTool.execute(
      { pattern: "*.ts", path: "many", limit: 2 },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    assert.ok(outputText(limited).includes("2 results limit reached"));
  });
});

test("grep finds regex matches with line numbers and honors glob filters", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "src"), { recursive: true });
    await writeFile(join(env.cwd, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;");
    await writeFile(join(env.cwd, "src", "b.md"), "alpha in markdown");
    const result = await grepTool.execute(
      { pattern: "alpha", path: "src" },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    const text = outputText(result);
    assert.ok(text.includes("a.ts:1: const alpha = 1;"));
    assert.ok(text.includes("b.md:1: alpha in markdown"));
    const filtered = await grepTool.execute(
      { pattern: "alpha", path: "src", glob: "*.ts" },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    const filteredText = outputText(filtered);
    assert.ok(filteredText.includes("a.ts:1:"));
    assert.ok(!filteredText.includes("b.md"));
  });
});

test("grep supports literal, ignoreCase, and context lines", async () => {
  await withEnv(async (env) => {
    await writeFile(join(env.cwd, "f.txt"), "before\nALPHA here\nafter\nfar");
    const literal = await grepTool.execute(
      { pattern: "alpha here", literal: true, ignoreCase: true },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    assert.ok(outputText(literal).includes("f.txt:2: ALPHA here"));
    const withContext = await grepTool.execute(
      { pattern: "ALPHA", context: 1 },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    const text = outputText(withContext);
    assert.ok(text.includes("f.txt-1- before"));
    assert.ok(text.includes("f.txt:2: ALPHA here"));
    assert.ok(text.includes("f.txt-3- after"));
    assert.ok(!text.includes("far"));
    const invalid = await grepTool.execute({ pattern: "(" }, apiFor(env), BACKGROUND_CONTEXT);
    assert.equal((invalid as { isError?: boolean }).isError, true);
    assert.ok(outputText(invalid).includes("Invalid regular expression"));
  });
});

test("grep enforces the match limit with proof of one more match", async () => {
  await withEnv(async (env) => {
    await writeFile(join(env.cwd, "f.txt"), "hit\nhit\nhit\nhit");
    const limited = await grepTool.execute(
      { pattern: "hit", limit: 2 },
      apiFor(env),
      BACKGROUND_CONTEXT,
    );
    const text = outputText(limited);
    assert.ok(text.includes("2 matches limit reached"));
    assert.equal((text.match(/f\.txt:\d+:/g) ?? []).length, 2);
    const noExtra = await writeFile(join(env.cwd, "g.txt"), "hit\nhit");
    void noExtra;
  });
});

test("grep respects .gitignore when walking", async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.cwd, "ignored"), { recursive: true });
    await writeFile(join(env.cwd, ".gitignore"), "ignored/\n");
    await writeFile(join(env.cwd, "ignored", "x.ts"), "needle");
    await writeFile(join(env.cwd, "y.ts"), "needle");
    const result = await grepTool.execute({ pattern: "needle" }, apiFor(env), BACKGROUND_CONTEXT);
    const text = outputText(result);
    assert.ok(text.includes("y.ts:1: needle"));
    assert.ok(!text.includes("ignored"));
  });
});

test("readonly-tools is read/ls/find/grep and coding-tools is read/write/edit/bash", () => {
  const readonly = createReadonlyToolsExtension();
  assert.equal(readonly.name, "eevee.readonly-tools");
  assert.deepEqual((readonly.tools ?? []).map((tool) => tool.name).sort(), [
    "find",
    "grep",
    "ls",
    "read",
  ]);
  const coding = createCodingToolsExtension();
  assert.equal(coding.name, "eevee.coding-tools");
  assert.deepEqual((coding.tools ?? []).map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "read",
    "write",
  ]);
});

test("powershell is opt-in only", () => {
  const coding = createCodingToolsExtension({ powerShell: true });
  assert.deepEqual((coding.tools ?? []).map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "powershell",
    "read",
    "write",
  ]);
});

test("search tools are opt-in for coding-tools", () => {
  const coding = createCodingToolsExtension({ searchTools: true });
  assert.deepEqual((coding.tools ?? []).map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "write",
  ]);
});

test("readonly tools are replay-safe", () => {
  for (const tool of [lsTool, findTool, grepTool]) {
    assert.equal(tool.replay, "safe");
  }
});
