import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createFoldStore, parseFolds } from "./folds.ts";

test("loading the fold store without a browser does not access Node web storage", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(new URL("./folds.ts", import.meta.url).href)})`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

test("parseFolds keeps 0|1 entries, forgives bad JSON and wrong shapes", () => {
  assert.deepEqual([...parseFolds(null)], []);
  assert.deepEqual([...parseFolds("not json")], []);
  assert.deepEqual([...parseFolds("[1,2]")], []);
  assert.deepEqual([...parseFolds("42")], []);
  assert.deepEqual(
    [...parseFolds('{"a":1,"b":0,"c":2,"d":"x"}')],
    [
      ["a", 1],
      ["b", 0],
    ],
  );
});

test("a choice reads back, defaults when unrecorded, and persists", () => {
  const storage = memoryStorage();
  const store = createFoldStore(storage, 10);
  assert.equal(store.open("w:p:t|worked:e:1"), false);
  assert.equal(store.open("w:p:t|worked:e:1", true), true);
  store.set("w:p:t|worked:e:1", true);
  assert.equal(store.open("w:p:t|worked:e:1"), true);

  const reloaded = createFoldStore(storage, 10);
  assert.equal(reloaded.open("w:p:t|worked:e:1"), true);
});

test("choices stay under the cap, the newest surviving", () => {
  const storage = memoryStorage();
  const store = createFoldStore(storage, 5);
  for (let i = 0; i < 8; i += 1) store.set(`k${i}`, true);
  assert.equal(store.open("k0"), false);
  assert.equal(store.open("k1"), false);
  assert.equal(store.open("k2"), false);
  assert.equal(store.open("k7"), true);

  // A fresh write renews a key instead of letting it age out.
  store.set("k3", false);
  store.set("k9", true);
  assert.equal(store.open("k4", true), true);
  assert.equal(store.open("k3", true), false);

  const stored = parseFolds(storage.data.get("eevee.folds.v1") ?? null);
  assert.equal(stored.size, 5);
});

test("a store without usable storage still works in memory", () => {
  const store = createFoldStore(undefined, 3);
  store.set("a", true);
  assert.equal(store.open("a"), true);
  const throwing = createFoldStore(
    {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    },
    3,
  );
  throwing.set("a", true);
  assert.equal(throwing.open("a"), true);
});
