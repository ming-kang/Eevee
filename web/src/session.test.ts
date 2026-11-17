import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError } from "../../src/api/client.ts";
import { parseRoute } from "./router.ts";
import { openSessionWith, type SessionEnv, Unauthorized } from "./session.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

test("先取走 #code= 并清掉 hash，再让路由从干净状态解析", async () => {
  let cleared = false;
  const env: SessionEnv = {
    origin: "http://127.0.0.1:19190",
    pathname: "/ui/",
    search: "",
    hash: "#code=one-time-code",
    clearHash: () => {
      cleared = true;
      env.hash = "";
    },
    storage: memoryStorage(),
    createClient: ({ token }) =>
      ({
        call: async (route: string) => {
          if (route === "POST /api/session") return { token: "tok-1" };
          if (route === "GET /api/status") {
            assert.equal(token, "tok-1");
            return { bootId: "b1", version: "0.0.1", port: 19190, projects: [] };
          }
          throw new Error(`unexpected ${route}`);
        },
      }) as never,
  };

  assert.equal(parseRoute(env.hash), undefined);
  const session = await openSessionWith(env);
  assert.equal(cleared, true);
  assert.equal(env.hash, "");
  assert.equal(session.token, "tok-1");
  assert.equal(env.storage.getItem("eevee.token"), "tok-1");
});

test("已有 token 时不改动普通路由 hash", async () => {
  let cleared = false;
  const env: SessionEnv = {
    origin: "http://127.0.0.1:19190",
    pathname: "/ui/",
    search: "",
    hash: "#/p/optics/t/t5",
    clearHash: () => {
      cleared = true;
    },
    storage: memoryStorage({ "eevee.token": "saved-tok" }),
    createClient: () =>
      ({
        call: async () => ({ bootId: "b1", version: "0.0.1", port: 19190, projects: [] }),
      }) as never,
  };

  const session = await openSessionWith(env);
  assert.equal(cleared, false);
  assert.equal(session.token, "saved-tok");
  assert.deepEqual(parseRoute(env.hash), { name: "worker", pid: "optics", tid: "t5" });
});

test("无 token 或会话过期时清掉旧 token 并抛出 Unauthorized", async () => {
  const storage = memoryStorage({ "eevee.token": "stale-tok" });
  const env: SessionEnv = {
    origin: "http://127.0.0.1:19190",
    pathname: "/ui/",
    search: "",
    hash: "",
    clearHash: () => {},
    storage,
    createClient: () =>
      ({
        call: async () => {
          throw new ApiRequestError(401, "unauthorized", "需要授权");
        },
      }) as never,
  };

  await assert.rejects(openSessionWith(env), Unauthorized);
  assert.equal(storage.getItem("eevee.token"), null);
});
