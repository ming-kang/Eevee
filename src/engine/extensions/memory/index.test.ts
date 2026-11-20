import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type JsonObject,
  MemoryStorage,
  type Report,
} from "@earendil-works/pi-durable";
import { MemoryConflict, MemoryStore } from "../../memory/store.ts";
import { createMemory } from "./index.ts";

const context = BACKGROUND_CONTEXT;
const call = (args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall("memory", args), { stopReason: "toolUse" });

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "eevee-memory-tool-"));
  const project = new MemoryStore(join(dir, "project"));
  const global = new MemoryStore(join(dir, "global"), "global");
  await mkdir(dir, { recursive: true });
  await project.ensure("alpha\nbeta\n");
  await global.ensure("global\n");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = createMemory({ repos: { project, global } }).memory;
  registry.install(extension);
  const reports: Report[] = [];
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: () => models, registry, onReport: (report) => reports.push(report) },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "m1" }, extensions: [extension] },
  });
  const run = async () => {
    await root.submit({ type: "input", content: "Update memory" }, context);
    await root.waitForIdle(context);
    assert.deepEqual(reports, []);
  };
  return { project, global, faux, run };
}

test("the memory adapter buffers all tool rounds, including delete and rename, into one run-end change", async (t) => {
  const { project, faux, run } = await setup(t);
  faux.setResponses([
    call({ action: "create", scope: "project", file: "draft.md", content: "draft" }),
    async () => {
      assert.equal(await project.read("draft.md"), undefined);
      return call({
        action: "edit",
        scope: "project",
        file: "MEMORY.md",
        oldText: "alpha",
        newText: "saved",
      });
    },
    call({ action: "rename", scope: "project", from: "draft.md", to: "renamed.md" }),
    call({ action: "delete", scope: "project", file: "renamed.md" }),
    async () => {
      assert.equal(await project.read("MEMORY.md"), "alpha\nbeta\n");
      assert.equal((await project.history()).length, 1);
      return fauxAssistantMessage("Done.");
    },
  ]);
  await run();
  assert.equal(await project.read("MEMORY.md"), "saved\nbeta\n");
  assert.equal(await project.read("draft.md"), undefined);
  assert.equal(await project.read("renamed.md"), undefined);
  const history = await project.history();
  assert.equal(history.length, 2);
  assert.equal(history[0]?.summary, "edit MEMORY.md");
  assert.deepEqual(history[0]?.source, { kind: "router" });

  faux.setResponses([
    call({ action: "create", scope: "project", file: "draft.md", content: "persisted" }),
    call({ action: "rename", scope: "project", from: "draft.md", to: "renamed.md" }),
    fauxAssistantMessage("Done."),
  ]);
  await run();
  assert.equal(await project.read("renamed.md"), "persisted");
  faux.setResponses([
    call({ action: "delete", scope: "project", file: "renamed.md" }),
    fauxAssistantMessage("Done."),
  ]);
  await run();
  assert.equal(await project.read("renamed.md"), undefined);
  assert.equal((await project.history()).length, 4);
});

test("run-end conflicts log the failure and write none of the buffered operations", async (t) => {
  const { project, faux, run } = await setup(t);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  faux.setResponses([
    call({ action: "create", scope: "project", file: "not-saved.md", content: "pending" }),
    call({
      action: "edit",
      scope: "project",
      file: "MEMORY.md",
      oldText: "alpha",
      newText: "stale",
    }),
    async () => {
      await writeFile(join(project.dir, "MEMORY.md"), "changed externally\n");
      return fauxAssistantMessage("Done.");
    },
  ]);
  await run();
  assert.equal(await project.read("not-saved.md"), undefined);
  assert.equal(await project.read("MEMORY.md"), "changed externally\n");
  assert.equal((await project.history()).length, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.[0]), /memory project.*Could not save/);
  assert.ok(errors[0]?.[1] instanceof MemoryConflict);
  faux.setResponses([fauxAssistantMessage("No changes.")]);
  await run();
  assert.equal((await project.history()).length, 1);
  assert.equal(errors.length, 1);
});

test("invalid global tool operations return errors and reads do not capture hand edits", async (t) => {
  const { global, faux, run } = await setup(t);
  await writeFile(join(global.dir, "MEMORY.md"), "hand edited\n");
  faux.setResponses([
    call({ action: "create", scope: "global", file: "forbidden.md", content: "bad" }),
    (transcript) => {
      const last = transcript.messages.at(-1);
      assert.equal(last?.role, "toolResult");
      assert.equal(last?.role === "toolResult" && last.isError, true);
      return call({ action: "history", scope: "global" });
    },
    fauxAssistantMessage("Done."),
  ]);
  await run();
  assert.equal((await global.history()).length, 1);
  assert.equal(await global.read("MEMORY.md"), "hand edited\n");
  assert.deepEqual(
    (await global.files()).map((file) => file.path),
    ["MEMORY.md"],
  );
});
