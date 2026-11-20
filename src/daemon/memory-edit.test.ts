import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsStore } from "../config/settings.ts";
import { Engine } from "../engine/engine.ts";
import { createModelRuntime } from "../engine/models/index.ts";
import { createClient } from "../protocol/client.ts";
import { TOKEN_HEADER } from "../protocol/contract.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { eeveePaths } from "../shared/paths.ts";

test("project and global memory routes save user edits with atomic version checks and policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-memory-edit-"));
  const paths = eeveePaths(home);
  const engine = await Engine.open({
    paths,
    settings: await SettingsStore.open(paths.settings),
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
  });
  const auth = new Auth();
  const server = createHttpServer({
    auth,
    uiDir: undefined,
    routes: createRoutes({ engine, auth, port: () => 0, version: "test", shutdown: () => {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createClient({ baseUrl, token: auth.token });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { [TOKEN_HEADER]: auth.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  try {
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const created = await client.call("POST /api/projects", {
      title: "Memory editing",
      workspaces: [workspace],
    });
    const prefix = `/api/projects/${created.id}/memory`;
    for (const root of [prefix, "/api/memory"]) {
      const initial = await request("GET", `${root}/files/MEMORY.md`);
      assert.equal(initial.status, 200);
      assert.match(String(initial.body.version), /^[0-9a-f]{64}$/);
      const saved = await request("PUT", `${root}/files/MEMORY.md`, {
        content: "",
        version: initial.body.version,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual((saved.body.change as { source: unknown }).source, { kind: "user" });
      const empty = await request("GET", `${root}/files/MEMORY.md`);
      assert.equal(empty.body.content, "");
      assert.notEqual(empty.body.version, initial.body.version);
      const same = await request("PUT", `${root}/files/MEMORY.md`, {
        content: "",
        version: empty.body.version,
      });
      assert.deepEqual(same.body, { file: empty.body, change: null });
      const stale = await request("PUT", `${root}/files/MEMORY.md`, {
        content: "stale",
        version: initial.body.version,
      });
      assert.equal(stale.status, 409);
      assert.match(stale.type ?? "", /application\/problem\+json/);
      assert.equal(stale.body.code, "memory_changed");
      assert.equal(stale.body.file, "MEMORY.md");
      assert.match(String(stale.body.title), /Reload/);
      assert.equal((await request("GET", `${root}/files/MEMORY.md`)).body.content, "");
      const last = await request("GET", `${root}/changes`);
      assert.equal(
        (last.body.changes as { id: number }[])[0]?.id,
        (saved.body.change as { id: number }).id,
      );
    }
    const file = `${prefix}/files/${encodeURIComponent("topics/new file.md")}`;
    const added = await request("PUT", file, { content: "new", version: "" });
    assert.equal(added.status, 200);
    assert.deepEqual((added.body.change as { source: unknown }).source, { kind: "user" });
    assert.equal((await request("PUT", file, { content: "collision", version: "" })).status, 409);
    const current = await request("GET", file);
    assert.equal(
      (await request("POST", `${file}/rename`, { to: "renamed.md", version: "stale" })).status,
      409,
    );
    const renamed = await request("POST", `${file}/rename`, {
      to: "renamed.md",
      version: current.body.version,
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual((renamed.body.change as { source: unknown }).source, { kind: "user" });
    assert.equal((await request("GET", file)).status, 404);
    const renamedPath = `${prefix}/files/renamed.md`;
    assert.equal((await request("DELETE", `${renamedPath}?version=stale`)).status, 409);
    assert.equal((await request("DELETE", `${renamedPath}?version=&version=other`)).status, 400);
    const deleted = await client.call("DELETE /api/projects/:project/memory/files/:file", {
      project: created.id,
      file: "renamed.md",
      query: { version: String(current.body.version) },
    });
    assert.equal(deleted.change?.source.kind, "user");
    assert.equal((await request("GET", renamedPath)).status, 404);
    assert.equal(
      (await request("PUT", renamedPath, { content: "stale", version: current.body.version }))
        .status,
      409,
    );
    assert.equal((await request("PUT", renamedPath, { content: "unconditional" })).status, 200);
    assert.equal((await request("DELETE", renamedPath)).status, 200);
    for (const [method, path, body] of [
      ["PUT", "/api/memory/files/other.md", { content: "no" }],
      ["DELETE", "/api/memory/files/MEMORY.md", undefined],
      ["POST", "/api/memory/files/MEMORY.md/rename", { to: "other.md" }],
    ] as const) {
      const refused = await request(method, path, body);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "memory_restricted");
      assert.match(String(refused.body.title), /editing.*MEMORY.md/);
    }
    await rm(join(paths.globalMemory, "MEMORY.md"));
    const forbiddenCreate = await request("PUT", "/api/memory/files/MEMORY.md", {
      content: "no",
      version: "",
    });
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.code, "memory_restricted");
    for (const file of [".git/config", "../outside.md"]) {
      assert.equal(
        (await request("PUT", `${prefix}/files/${encodeURIComponent(file)}`, { content: "no" }))
          .status,
        400,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
