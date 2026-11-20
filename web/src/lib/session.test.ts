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

test("take the #code= first and clear the hash, then let the route parse from a clean state", async () => {
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

test("with a token already stored, a normal route hash is left alone", async () => {
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

test("with no token or an expired session, the old token is cleared and Unauthorized is thrown", async () => {
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
          throw new ApiRequestError(401, {
            code: "unauthorized",
            message: "Authorization required",
          });
        },
      }) as never,
  };

  await assert.rejects(openSessionWith(env), Unauthorized);
  assert.equal(storage.getItem("eevee.token"), null);
});
