import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadUserExtensions } from "./user-extensions.ts";

test("用户扩展：默认导出 extension 或工厂函数，保留名、重名和错误各自报告", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-ext-"));
  try {
    const files: Record<string, string> = {
      "a-object.mjs": `export default { name: "weather", tools: [] };`,
      "b-factory.mjs": `export default async () => ({ name: "notes" });`,
      "c-reserved.mjs": `export default { name: "eevee.sneaky" };`,
      "d-duplicate.mjs": `export default { name: "weather" };`,
      "e-broken.mjs": `throw new Error("坏了");`,
      "f-shape.mjs": `export default 42;`,
      "README.md": "不是扩展",
    };
    await mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);

    const { extensions, status } = await loadUserExtensions(dir);
    assert.deepEqual(
      extensions.map((e) => e.name),
      ["weather", "notes"],
    );
    const errors = Object.fromEntries(status.map((s) => [s.file, s.error ?? "ok"]));
    assert.deepEqual(errors, {
      "a-object.mjs": "ok",
      "b-factory.mjs": "ok",
      "c-reserved.mjs": { code: "name_reserved", name: "eevee.sneaky" },
      "d-duplicate.mjs": { code: "name_taken", name: "weather" },
      "e-broken.mjs": { code: "failed", detail: "坏了" },
      "f-shape.mjs": { code: "bad_export" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有扩展目录时什么也不加载", async () => {
  const { extensions, status } = await loadUserExtensions(join(tmpdir(), "eevee-no-such-dir"));
  assert.deepEqual([extensions, status], [[], []]);
});
