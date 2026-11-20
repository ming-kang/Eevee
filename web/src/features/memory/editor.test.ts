import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../../../../src/protocol/client.ts";
import { createMemoryEditor } from "./editor.ts";

type Request = { url: URL; body: Record<string, unknown> | undefined; method: string };
function fixture(reply: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const client = createClient({
    baseUrl: "http://localhost",
    fetch: async (input, init) => {
      const request = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined
            ? undefined
            : (JSON.parse(String(init.body)) as Record<string, unknown>),
      };
      requests.push(request);
      return reply(request);
    },
  });
  let project = "p1";
  const saved: string[] = [];
  const editor = createMemoryEditor(
    client,
    () => project,
    async (draft) => {
      saved.push(draft.file);
    },
  );
  return {
    editor,
    requests,
    saved,
    switchProject: () => {
      project = "p2";
    },
  };
}
const file = (content = "original", version = "v1") =>
  Response.json({ path: "MEMORY.md", content, version });
const changed = () =>
  Response.json(
    {
      status: 409,
      title: "Changed",
      code: "memory_changed",
      file: "MEMORY.md",
    },
    { status: 409 },
  );

test("editor loads fresh content, saves with its version and original project, and can cancel", async () => {
  const { editor, requests, saved, switchProject } = fixture((request) =>
    request.method === "GET" ? file() : Response.json({ id: 2 }),
  );
  await editor.open("edit", "project", "MEMORY.md");
  assert.equal(editor.draft.value?.content, "original");
  if (!editor.draft.value) throw new Error("Missing draft");
  editor.draft.value.content = "";
  switchProject();
  await editor.submit();
  assert.equal(requests[1]?.url.pathname, "/api/projects/p1/memory/files/MEMORY.md");
  assert.deepEqual(requests[1]?.body, { content: "", version: "v1" });
  assert.equal(editor.draft.value, undefined);
  assert.deepEqual(saved, ["MEMORY.md"]);
  await editor.open("edit", "global", "MEMORY.md");
  assert.equal(requests.at(-1)?.url.pathname, "/api/memory/files/MEMORY.md");
  await editor.submit();
  assert.deepEqual(requests.at(-1)?.body, { content: "original", version: "v1" });
  await editor.open("new", "project");
  const count = requests.length;
  editor.close();
  await editor.submit();
  assert.equal(requests.length, count);
});

test("409 retains the draft and offers reload before retrying with the latest version", async () => {
  let reject = true;
  const { editor, requests } = fixture((request) =>
    request.method === "GET" ? file("latest", "v2") : reject ? changed() : Response.json({ id: 2 }),
  );
  await editor.open("new", "project");
  if (!editor.draft.value) throw new Error("Missing draft");
  editor.draft.value.name = "MEMORY.md";
  editor.draft.value.content = "draft";
  await editor.submit();
  assert.deepEqual(requests[0]?.body, { content: "draft", version: "" });
  assert.equal(editor.changed.value, true);
  assert.match(editor.error.value ?? "", /Reload/);
  assert.equal(editor.draft.value.content, "draft");
  await editor.reload();
  assert.equal(editor.draft.value.content, "latest");
  assert.equal(editor.draft.value.mode, "edit");
  assert.equal(editor.changed.value, false);
  reject = false;
  await editor.submit();
  assert.deepEqual(requests.at(-1)?.body, { content: "latest", version: "v2" });
});

test("delete and rename use the loaded version; delete does not happen before confirmation", async () => {
  const { editor, requests } = fixture((request) =>
    request.method === "GET" ? file() : Response.json({ id: 2 }),
  );
  await editor.open("delete", "project", "MEMORY.md");
  assert.equal(requests.length, 1);
  await editor.submit();
  assert.equal(requests[1]?.method, "DELETE");
  assert.equal(requests[1]?.url.searchParams.get("version"), "v1");
  await editor.open("rename", "project", "MEMORY.md");
  if (!editor.draft.value) throw new Error("Missing draft");
  editor.draft.value.name = "topics/new.md";
  await editor.submit();
  assert.equal(requests.at(-1)?.url.pathname, "/api/projects/p1/memory/files/MEMORY.md/rename");
  assert.deepEqual(requests.at(-1)?.body, { to: "topics/new.md", version: "v1" });
});

test("load errors disable submission, cancelled requests cannot revive a draft, and saves do not duplicate", async () => {
  const failing = fixture(() => {
    throw new Error("Offline");
  });
  await failing.editor.open("edit", "global", "MEMORY.md");
  assert.equal(failing.editor.error.value, "Offline");
  assert.equal(failing.editor.draft.value?.loaded, false);
  await failing.editor.submit();
  assert.equal(failing.requests.length, 1);
  let release = (_: Response) => {};
  const waiting = fixture(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const open = waiting.editor.open("edit", "project", "MEMORY.md");
  waiting.editor.close();
  release(file());
  await open;
  assert.equal(waiting.editor.draft.value, undefined);
  await waiting.editor.open("new", "project");
  const save = waiting.editor.submit();
  await waiting.editor.submit();
  assert.equal(waiting.requests.length, 2);
  release(Response.json({ id: 2 }));
  await save;
});

test("reloading a deleted file records expected absence rather than allowing a stale overwrite", async () => {
  const { editor } = fixture(() =>
    Response.json(
      {
        code: "no_memory_file",
        file: "MEMORY.md",
        status: 404,
        title: "Missing",
      },
      { status: 404 },
    ),
  );
  await editor.open("edit", "project", "MEMORY.md");
  assert.equal(editor.draft.value?.version, "");
  assert.equal(editor.draft.value?.missing, true);
  assert.equal(editor.draft.value?.loaded, true);
  await editor.open("delete", "project", "MEMORY.md");
  assert.equal(editor.draft.value?.loaded, false);
  await editor.open("edit", "global", "MEMORY.md");
  assert.equal(editor.draft.value?.loaded, false);
});
