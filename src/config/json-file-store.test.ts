import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { int, obj } from "@earendil-works/pi-schema";
import { JsonFileStore } from "./json-file-store.ts";
import { ConfigError } from "./load.ts";

const schema = obj({ count: int({ minimum: 0 }) });

test("JSON stores use a fallback, serialize updates, and read external changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-json-"));
  try {
    const path = join(dir, "nested", "store.json");
    const store = await JsonFileStore.open(schema, path, { count: 0 });
    assert.deepEqual(store.current, { count: 0 });
    await Promise.all(
      Array.from({ length: 12 }, () => store.update(({ count }) => ({ count: count + 1 }))),
    );
    assert.deepEqual(store.current, { count: 12 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 12 });
    await writeFile(path, '{"count":20}');
    assert.deepEqual(await store.update(({ count }) => ({ count: count + 1 })), { count: 21 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed validation and writes preserve current state and do not poison the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-json-"));
  try {
    const path = join(dir, "store.json");
    const store = await JsonFileStore.open(schema, path, { count: 0 });
    await store.update(() => ({ count: 1 }));
    await assert.rejects(
      store.update(() => ({ count: -1 })),
      ConfigError,
    );
    assert.deepEqual(store.current, { count: 1 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 1 });
    await writeFile(path, "not JSON");
    await assert.rejects(
      store.update(() => ({ count: 2 })),
      SyntaxError,
    );
    assert.deepEqual(store.current, { count: 1 });
    await writeFile(path, '{"count":3}');
    assert.deepEqual(await store.update(({ count }) => ({ count: count + 1 })), { count: 4 });
    const blocked = join(dir, "store.json", "child.json");
    const failing = new JsonFileStore(schema, blocked, { count: 0 });
    await assert.rejects(failing.update(() => ({ count: 1 })));
    assert.deepEqual(failing.current, { count: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
