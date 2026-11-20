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
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Board, MemoryDraft, TicketBinding, TicketDoc } from "../../docs.ts";
import { MemoryStore } from "../../memory/store.ts";
import type { EngineEvent } from "../../orchestration/delivery.ts";
import { Proposals } from "../../project/proposals.ts";
import { createMemory } from "./index.ts";

const context = BACKGROUND_CONTEXT;
const call = (args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall("memory", args), { stopReason: "toolUse" });

async function setup(t: TestContext, persistent = false) {
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
  const storage = () =>
    persistent
      ? openNodeSqliteStorage(join(dir, "session.db"))
      : Promise.resolve(new MemoryStorage());
  const open = async () =>
    Harness.open(
      await storage(),
      { models: () => models, registry, onReport: (report) => reports.push(report) },
      context,
    );
  let harness = await open();
  const events: EngineEvent[] = [];
  const service = () =>
    new Proposals({
      project: "p1",
      harness,
      context,
      stores: { project, global },
      dispatch: async (event, change) => {
        if (change) await harness.commit(change, context);
        events.push(event);
      },
    });
  let proposals = service();
  t.after(async () => {
    await proposals.close();
    await harness.close(context);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  let root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "m1" }, extensions: [extension] },
  });
  const run = async () => {
    await root.submit({ type: "input", content: "Update memory" }, context);
    await root.waitForIdle(context);
    assert.deepEqual(reports, []);
  };
  return {
    project,
    global,
    faux,
    run,
    events,
    get harness() {
      return harness;
    },
    get proposals() {
      return proposals;
    },
    reopen: async () => {
      await proposals.close();
      await harness.close(context);
      harness = await open();
      root = await harness.root(context);
      proposals = service();
    },
  };
}

test("tools persist validated drafts, then submit one proposal per scope without writing memory", async (t) => {
  const { project, global, faux, run, harness, proposals } = await setup(t);
  faux.setResponses([
    call({ action: "create", scope: "project", file: "draft.md", content: "draft" }),
    async () => {
      assert.equal(await project.read("draft.md"), undefined);
      assert.equal(
        (await harness.snapshot(MemoryDraft, ROOT_CONVERSATION_ID, context))?.scopes.project
          ?.actions.length,
        1,
      );
      assert.deepEqual((await harness.snapshot(Board, context))?.openProposals ?? [], []);
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
    call({ action: "write", scope: "global", file: "MEMORY.md", content: "proposed global\n" }),
    async () => {
      assert.equal(await project.read("MEMORY.md"), "alpha\nbeta\n");
      assert.equal((await project.history()).length, 1);
      return fauxAssistantMessage("Done.");
    },
  ]);
  await run();
  assert.equal(await project.read("MEMORY.md"), "alpha\nbeta\n");
  assert.equal(await global.read("MEMORY.md"), "global\n");
  assert.equal((await proposals.list()).length, 2);
  assert.equal((await proposals.get("m1")).files.length, 1);
  assert.ok(
    (await proposals.get("m1")).files[0]?.hunks.some((h) =>
      h.lines.some((l) => l.kind === "add" && l.text === "saved"),
    ),
  );
  await proposals.approve("m1");
  await proposals.approve("m2");
  assert.equal(await global.read("MEMORY.md"), "proposed global\n");
  assert.deepEqual(
    (await harness.snapshot(MemoryDraft, ROOT_CONVERSATION_ID, context))?.scopes,
    {},
  );
  assert.equal(await project.read("MEMORY.md"), "saved\nbeta\n");
  assert.equal(await project.read("draft.md"), undefined);
  assert.equal(await project.read("renamed.md"), undefined);
  const history = await project.history();
  assert.equal(history.length, 2);
  assert.match(history[0]?.summary ?? "", /edit MEMORY.md/);
  assert.deepEqual(history[0]?.source, { kind: "router" });

  faux.setResponses([
    call({ action: "create", scope: "project", file: "draft.md", content: "persisted" }),
    call({ action: "rename", scope: "project", from: "draft.md", to: "renamed.md" }),
    fauxAssistantMessage("Done."),
  ]);
  await run();
  assert.equal(await project.read("renamed.md"), undefined);
  await proposals.approve("m3");
  assert.equal(await project.read("renamed.md"), "persisted");
  faux.setResponses([
    call({ action: "delete", scope: "project", file: "renamed.md" }),
    fauxAssistantMessage("Done."),
  ]);
  await run();
  await proposals.approve("m4");
  assert.equal(await project.read("renamed.md"), undefined);
  assert.equal((await project.history()).length, 4);
});

test("hand edits after drafting make approval stale atomically and notify the Router", async (t) => {
  const { project, faux, run, proposals, events, harness } = await setup(t);
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
  assert.equal((await proposals.get("m1")).status, "pending");
  await assert.rejects(proposals.approve("m1"), {
    problem: { code: "memory_changed", file: "MEMORY.md" },
  });
  assert.equal((await proposals.get("m1")).status, "stale");
  assert.deepEqual((await harness.snapshot(Board, context))?.openProposals, []);
  assert.equal(await project.read("not-saved.md"), undefined);
  assert.deepEqual(
    events.map((event) => event.type),
    ["proposal-decided"],
  );
  assert.ok(
    events[0]?.type === "proposal-decided" &&
      events[0].proposal.status === "stale" &&
      events[0].file === "MEMORY.md",
  );
  await assert.rejects(proposals.reject("m1"), {
    problem: { code: "proposal_decided", proposalId: "m1" },
  });
  faux.setResponses([fauxAssistantMessage("No changes.")]);
  await run();
  assert.equal((await project.history()).length, 1);
  assert.equal((await proposals.list()).length, 1);
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

test("invalid draft operations roll back, and zero-net drafts produce no proposals", async (t) => {
  const { faux, harness, proposals, run } = await setup(t);
  faux.setResponses([
    call({ action: "create", scope: "project", file: "draft.md", content: "one" }),
    call({
      action: "edit",
      scope: "project",
      file: "draft.md",
      oldText: "missing",
      newText: "bad",
    }),
    (transcript) => {
      const last = transcript.messages.at(-1);
      assert.ok(last?.role === "toolResult" && last.isError);
      return call({
        action: "edit",
        scope: "project",
        file: "draft.md",
        oldText: "one",
        newText: "two",
      });
    },
    async () => {
      assert.equal(
        (await harness.snapshot(MemoryDraft, ROOT_CONVERSATION_ID, context))?.scopes.project
          ?.actions.length,
        2,
      );
      return call({ action: "delete", scope: "project", file: "draft.md" });
    },
    fauxAssistantMessage("Done."),
  ]);
  await run();
  assert.deepEqual(await proposals.list(), []);
  await assert.rejects(proposals.get("m1"), { problem: { code: "no_proposal", proposalId: "m1" } });
});

test("a decision interrupted after applying memory can be retried without a second change", async (t) => {
  const { project, global, faux, run, proposals, harness } = await setup(t);
  faux.setResponses([
    call({ action: "write", scope: "project", file: "MEMORY.md", content: "approved once" }),
    fauxAssistantMessage("Done."),
  ]);
  await run();
  const interrupted = new Proposals({
    project: "p1",
    harness,
    context,
    stores: { project, global },
    dispatch: async () => {
      throw new Error("Decision commit unavailable");
    },
  });
  await assert.rejects(interrupted.approve("m1"), /Decision commit unavailable/);
  assert.equal(await project.read("MEMORY.md"), "approved once");
  assert.equal((await proposals.get("m1")).status, "pending");
  const change = await proposals.approve("m1");
  assert.equal(change.id, 2);
  assert.equal((await project.history()).length, 2);
  assert.equal((await proposals.get("m1")).status, "approved");
});

test("a persisted conversation draft survives reopening SQLite and submits at run end", async (t) => {
  const f = await setup(t, true);
  const actions = await f.project.extend([], {
    action: "write",
    file: "MEMORY.md",
    content: "survives restart\n",
  });
  await f.harness.commit(async (tx) => {
    const draft = await tx.doc(MemoryDraft, ROOT_CONVERSATION_ID);
    draft.scopes.project = { actions, source: { kind: "router" }, createdAt: 1 };
  }, context);
  await f.reopen();
  assert.deepEqual(
    (await f.harness.snapshot(MemoryDraft, ROOT_CONVERSATION_ID, context))?.scopes.project?.actions,
    actions,
  );
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  await f.run();
  assert.equal((await f.proposals.list()).length, 1);
  assert.equal(await f.project.read("MEMORY.md"), "alpha\nbeta\n");
  await f.proposals.approve("m1");
  assert.equal(await f.project.read("MEMORY.md"), "survives restart\n");
});

test("undo is a separate immediate proposal, preserves dreaming source and ticket, and needs approval", async (t) => {
  const { project, faux, run, proposals, harness } = await setup(t);
  const original = await project.apply([{ action: "write", file: "MEMORY.md", content: "new\n" }], {
    kind: "user",
  });
  assert.ok(original);
  await harness.commit(async (tx) => {
    (await tx.doc(TicketBinding, ROOT_CONVERSATION_ID)).ticketId = "t1";
    await tx.doc(TicketDoc, "t1", {
      id: "t1",
      role: "dreamer",
      title: "Tidy",
      goal: "Tidy",
      inputs: [],
      acceptance: [],
      deliverTo: [],
      status: "done",
      createdAt: 0,
      conversationId: ROOT_CONVERSATION_ID,
      closedAt: 1,
    });
  }, context);
  faux.setResponses([
    call({ action: "undo", scope: "project", change: original.id }),
    async () => {
      assert.equal((await proposals.list()).length, 1);
      assert.equal(await project.read("MEMORY.md"), "new\n");
      return fauxAssistantMessage("Proposed.");
    },
  ]);
  await run();
  const preview = await proposals.get("m1");
  assert.equal(preview.actions.length, 1);
  assert.equal(preview.actions[0]?.action, "undo");
  assert.ok(
    preview.files[0]?.hunks.some((h) =>
      h.lines.some((l) => l.kind === "add" && l.text === "alpha"),
    ),
  );
  const undone = await proposals.approve("m1");
  assert.deepEqual(undone.source, { kind: "dreaming", ticketId: "t1" });
  assert.equal(await project.read("MEMORY.md"), "alpha\nbeta\n");
  await assert.rejects(proposals.approve("m1"), {
    problem: { code: "proposal_decided", proposalId: "m1" },
  });
  await proposals.reject("m2").then(
    () => assert.fail("missing proposal"),
    (error) => assert.equal(error.problem.code, "no_proposal"),
  );
});
