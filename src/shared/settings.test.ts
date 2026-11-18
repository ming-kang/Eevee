import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError } from "./config.ts";
import { DEFAULT_SETTINGS, loadSettings, SettingsStore } from "./settings.ts";

async function withFile(content: unknown, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-settings-"));
  const path = join(dir, "settings.json");
  if (content !== undefined) await writeFile(path, JSON.stringify(content));
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("没有 settings.json 时用默认值，写了的字段覆盖默认值", async () => {
  await withFile(undefined, async (path) => {
    assert.deepEqual(await loadSettings(path), DEFAULT_SETTINGS);
  });
  const stored = { maxActiveWorkers: 5, roles: { router: { extensions: ["mcp.deepwiki"] } } };
  await withFile(stored, async (path) => {
    const settings = await loadSettings(path);
    assert.equal(settings.maxActiveWorkers, 5);
    assert.equal(settings.port, DEFAULT_SETTINGS.port);
    assert.deepEqual(settings.roles.router?.extensions, ["mcp.deepwiki"]);
  });
});

test("格式不对的 settings.json 指出字段", async () => {
  await withFile({ maxActiveWorkers: 0, roles: { router: { maxTurns: "多" } } }, async (path) => {
    await assert.rejects(loadSettings(path), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /maxActiveWorkers/);
      assert.match(error.message, /maxTurns/);
      return true;
    });
  });
});

test("修改只写用户给的字段，写之前校验", async () => {
  await withFile({ port: 20000 }, async (path) => {
    const store = await SettingsStore.open(path);
    await store.update((stored) => ({ ...stored, dreamIntervalMs: 0 }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { port: 20000, dreamIntervalMs: 0 });
    assert.equal(store.current.dreamIntervalMs, 0);
    await assert.rejects(
      store.update((stored) => ({ ...stored, handoffThreshold: 2 })),
      ConfigError,
    );
    assert.equal(store.current.handoffThreshold, DEFAULT_SETTINGS.handoffThreshold);
  });
});

test("默认模型可以带思考档位，档位不在列表里时指出字段", async () => {
  const models = { router: { provider: "faux", modelId: "brain", thinkingLevel: "high" } };
  await withFile({ models }, async (path) => {
    assert.deepEqual((await loadSettings(path)).models, models);
  });
  const wrong = {
    models: { worker: { provider: "faux", modelId: "brain", thinkingLevel: "huge" } },
  };
  await withFile(wrong, async (path) => {
    await assert.rejects(loadSettings(path), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /thinkingLevel/);
      return true;
    });
  });
});
