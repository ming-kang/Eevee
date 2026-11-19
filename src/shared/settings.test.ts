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

test("defaults apply with no settings.json, and written fields override them", async () => {
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

test("a malformed settings.json names the offending fields", async () => {
  await withFile({ maxActiveWorkers: 0, roles: { router: { maxTurns: "lots" } } }, async (path) => {
    await assert.rejects(loadSettings(path), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /maxActiveWorkers/);
      assert.match(error.message, /maxTurns/);
      return true;
    });
  });
});

test("an update writes only the given fields and validates before writing", async () => {
  await withFile({ port: 20000 }, async (path) => {
    const store = await SettingsStore.open(path);
    await store.update((stored) => ({
      ...stored,
      dreaming: { enabled: false, idleMs: 0, minGapMs: 0, afterTickets: 1, afterLessons: 1 },
    }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      port: 20000,
      dreaming: { enabled: false, idleMs: 0, minGapMs: 0, afterTickets: 1, afterLessons: 1 },
    });
    assert.equal(store.current.dreaming.enabled, false);
    await assert.rejects(
      store.update((stored) => ({ ...stored, handoffThreshold: 2 })),
      ConfigError,
    );
    assert.equal(store.current.handoffThreshold, DEFAULT_SETTINGS.handoffThreshold);
  });
});

test("a stored dreamIntervalMs still reads: 0 turns Dreaming off, other values are ignored, and no update writes it back", async () => {
  await withFile({ dreamIntervalMs: 0 }, async (path) => {
    assert.equal((await loadSettings(path)).dreaming.enabled, false);
  });
  await withFile({ dreamIntervalMs: 60_000, dreaming: { enabled: false } }, async (path) => {
    const settings = await loadSettings(path);
    assert.equal(settings.dreaming.enabled, false);
    assert.equal(settings.dreaming.idleMs, DEFAULT_SETTINGS.dreaming.idleMs);
  });
  await withFile({ port: 20000, dreamIntervalMs: 0 }, async (path) => {
    const store = await SettingsStore.open(path);
    assert.equal(store.current.dreaming.enabled, false);
    await store.update((stored) => ({ ...stored, port: 20001 }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { port: 20001 });
    assert.equal(store.current.dreaming.enabled, DEFAULT_SETTINGS.dreaming.enabled);
  });
});

test("a default model may carry a thinking level, and an unknown level names the field", async () => {
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
