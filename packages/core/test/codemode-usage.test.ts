import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  Conversation,
  EntryRecord,
  HarnessSettings,
  Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { AGENT_EXTENSIONS, type CodemodeHandleOptions } from "@eevee/agent";
import {
  CompactionUsageDoc,
  NOTICE_ENTRY_KIND,
  openProject,
  type ProjectHandle,
} from "../src/index.ts";

type ProjectFixture = {
  readonly dir: string;
  readonly faux: FauxProviderHandle;
  readonly storage: Storage;
  readonly project: ProjectHandle;
};

type FixtureOptions = {
  readonly codemode?: CodemodeHandleOptions | false;
  readonly settings?: HarnessSettings;
  readonly storage?: Storage;
};

const MODEL_ID = "faux-1";

async function openFixture(options: FixtureOptions = {}): Promise<ProjectFixture> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-codemode-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = options.storage ?? new MemoryStorage();
  const project = await openProject(storage, {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
    ...(options.codemode === undefined ? {} : { codemode: options.codemode }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  return { dir, faux, storage, project };
}

async function closeFixture(fixture: ProjectFixture): Promise<void> {
  await fixture.project.close().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function responses(brain: FauxResponseFactory, count = 40): FauxResponseFactory[] {
  return Array.from({ length: count }, () => brain);
}

function messageText(message: Message): string {
  if (message.role === "user") return contentText(message.content);
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "toolResult") return contentText(message.content);
  return "";
}

function contextText(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

function entryText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  return message === undefined ? "" : messageText(message);
}

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries(
    { order: "ascending" },
    500,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return [...page.items];
}

async function toolResultEntries(
  conversation: Conversation,
  toolName: string,
): Promise<{ readonly isError: boolean; readonly text: string }[]> {
  const results: { readonly isError: boolean; readonly text: string }[] = [];
  for (const entry of await entries(conversation)) {
    const message = entry.model?.[0];
    if (message?.role !== "toolResult" || message.toolName !== toolName) continue;
    results.push({ isError: message.isError, text: messageText(message) });
  }
  return results;
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("Router codemode is limited to readonly tools while Worker codemode can write", async () => {
  const fixture = await openFixture({ codemode: { mode: "inline" } });
  try {
    await writeFile(join(fixture.dir, "note.txt"), "codemode roundtrip note");
    await writeFile(join(fixture.dir, "other.txt"), "other");

    const routerCode = [
      'const listing = await tools.ls({ path: "." });',
      'const content = await tools.read({ path: "note.txt" });',
      'let writeOutcome = "escaped";',
      "try {",
      '  await tools.write({ path: "router-escape.txt", content: "escape" });',
      "} catch (error) {",
      '  writeOutcome = "denied";',
      "}",
      'let bashOutcome = "escaped";',
      "try {",
      '  await tools.bash({ command: "echo escape" });',
      "} catch (error) {",
      '  bashOutcome = "denied";',
      "}",
      'return "entries=" + listing.entries.join(",") + "|read=" + content.trim() + "|write:" + ("write" in tools) + "/" + writeOutcome + "|bash:" + ("bash" in tools) + "/" + bashOutcome;',
    ].join("\n");
    const workerCode = [
      'await tools.write({ path: "worker-written.txt", content: "worker codemode write ok" });',
      'const content = await tools.read({ path: "worker-written.txt" });',
      'return "worker-write-read:" + content.trim();',
    ].join("\n");

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("run-router-codemode")) {
          return fauxAssistantMessage([fauxToolCall("codemode", { code: routerCode })], {
            stopReason: "toolUse",
          });
        }
        if (text.includes("spawn-codemode-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "coder",
                prompt: "worker-codemode-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-codemode-task")) {
          return fauxAssistantMessage([fauxToolCall("codemode", { code: workerCode })], {
            stopReason: "toolUse",
          });
        }
        if (text.includes("Worker coder") && text.includes("worker codemode report done")) {
          return fauxAssistantMessage("router saw coder handoff");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("router delegated coder");
        if (last.toolName === "codemode") {
          const serialized = contextText(context);
          if (serialized.includes("worker-codemode-task")) {
            return fauxAssistantMessage("worker codemode report done");
          }
          return fauxAssistantMessage("router codemode done");
        }
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const routerSubmission = await fixture.project.send("run-router-codemode");
    await routerSubmission.wait(BACKGROUND_CONTEXT);

    const routerResults = await toolResultEntries(fixture.project.root, "codemode");
    assert.equal(routerResults.length, 1);
    const routerResult = routerResults[0];
    assert.ok(routerResult !== undefined);
    assert.equal(routerResult.isError, false);
    assert.ok(routerResult.text.includes("note.txt"), `expected ls entries: ${routerResult.text}`);
    assert.ok(routerResult.text.includes("other.txt"), `expected ls entries: ${routerResult.text}`);
    assert.ok(
      routerResult.text.includes("codemode roundtrip note"),
      `expected read content: ${routerResult.text}`,
    );
    assert.ok(
      routerResult.text.includes("write:false/denied"),
      `expected write denied for Router: ${routerResult.text}`,
    );
    assert.ok(
      routerResult.text.includes("bash:false/denied"),
      `expected bash denied for Router: ${routerResult.text}`,
    );
    assert.equal(
      await pathExists(join(fixture.dir, "router-escape.txt")),
      false,
      "router-escape.txt must not exist",
    );

    const spawnSubmission = await fixture.project.send("spawn-codemode-worker");
    await spawnSubmission.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => {
      const rootEntries = await entries(fixture.project.root);
      return (
        rootEntries.some((entry) => entry.kind === NOTICE_ENTRY_KIND) &&
        rootEntries.some((entry) => entryText(entry).includes("router saw coder handoff"))
      );
    }, "worker codemode handoff and router answer");

    assert.equal(
      await pathExists(join(fixture.dir, "worker-written.txt")),
      true,
      "worker-written.txt must exist",
    );
    const workers = await fixture.project.workers();
    assert.equal(workers.length, 1);
    const worker = workers[0];
    assert.ok(worker !== undefined);
    const workerConversation = await fixture.project.harness.conversation(
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(workerConversation !== undefined);
    const workerResults = await toolResultEntries(workerConversation, "codemode");
    assert.equal(workerResults.length, 1);
    const workerResult = workerResults[0];
    assert.ok(workerResult !== undefined);
    assert.equal(workerResult.isError, false);
    assert.ok(
      workerResult.text.includes("worker-write-read:worker codemode write ok"),
      `expected worker write+read roundtrip: ${workerResult.text}`,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("codemode extension is installed by default without a codemode option", async () => {
  const fixture = await openFixture();
  try {
    const agent = await fixture.project.root.agent(BACKGROUND_CONTEXT);
    assert.ok(
      agent.extensions.some((extension) => extension.name === AGENT_EXTENSIONS.codemode),
      "router agent must include eevee.codemode by default",
    );
    assert.ok(
      agent.tools.some((tool) => tool.name === "codemode"),
      "router agent must offer the codemode tool by default",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("worker cached-compaction usage persists in CompactionUsageDoc and project.usage()", async () => {
  const storage = new MemoryStorage();
  storage.close = () => Promise.resolve();
  const settings: HarnessSettings = {
    compaction: {
      enabled: true,
      keepRecentTokens: 20,
      reserveTokens: 1000,
      backgroundTokens: 0,
    },
  };
  const fixture = await openFixture({ codemode: { mode: "inline" }, settings, storage });
  const dir = fixture.dir;
  try {
    const pad = "detailed compaction context padding ".repeat(12);
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("<kept-start>")) {
          return fauxAssistantMessage("## Goal\nVerify cached compaction usage accounting.");
        }
        if (text.includes("spawn-compaction-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "compactor",
                prompt: `compaction-worker-task ${pad}`,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("compaction-worker-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "compaction.txt", content: `compaction body ${pad}` })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Worker compactor") && text.includes("compaction worker final report")) {
          return fauxAssistantMessage("router saw compactor handoff");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") {
          return fauxAssistantMessage("router delegated compactor");
        }
        if (last.toolName === "write") {
          return fauxAssistantMessage(`compaction worker final report ${pad}`);
        }
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-compaction-worker");
    await submission.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () =>
        (await entries(fixture.project.root)).some((entry) =>
          entryText(entry).includes("router saw compactor handoff"),
        ),
      "compactor handoff and router answer",
    );

    const workers = await fixture.project.workers();
    const worker = workers[0];
    assert.ok(worker !== undefined);
    const workerConversation = await fixture.project.harness.conversation(
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(workerConversation !== undefined);

    const key = `${fixture.faux.provider.id}/${MODEL_ID}`;
    const usageBefore = await fixture.project.usage();
    const beforeTokens = usageBefore.models[key]?.totalTokens ?? 0;
    assert.ok(beforeTokens > 0, "generation usage must be tracked before compaction");
    const beforeCost = usageBefore.models[key]?.cost.total ?? 0;

    const compactTask = await workerConversation.compact(undefined, BACKGROUND_CONTEXT);
    const settled = await fixture.project.harness.waitForTask(compactTask, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    await workerConversation.waitForIdle(BACKGROUND_CONTEXT);

    // project.usage() drains the compaction usage pass, so the doc snapshot afterwards is settled.
    const usageAfter = await fixture.project.usage();
    const recorded = (
      await fixture.project.harness.snapshot(CompactionUsageDoc, BACKGROUND_CONTEXT)
    )?.models[key];
    assert.ok(recorded !== undefined, "compaction usage must be persisted for the worker model");
    assert.ok(recorded.totalTokens > 0, "compaction usage must carry tokens");

    const afterTokens = usageAfter.models[key]?.totalTokens ?? 0;
    assert.equal(
      afterTokens - beforeTokens,
      recorded.totalTokens,
      "project.usage() must reflect exactly the persisted compaction tokens on top of generation usage",
    );
    const afterCost = usageAfter.models[key]?.cost.total ?? 0;
    assert.equal(afterCost - beforeCost, recorded.cost.total);
    assert.equal(typeof usageAfter.models[key]?.cost.total, "number");

    await fixture.project.close();

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(responses(() => fauxAssistantMessage("idle")));
    const reopened = await openProject(storage, {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
      codemode: { mode: "inline" },
      settings,
    });
    try {
      const reopenedDoc = await reopened.harness.snapshot(CompactionUsageDoc, BACKGROUND_CONTEXT);
      assert.equal(
        reopenedDoc?.models[key]?.totalTokens,
        recorded.totalTokens,
        "reopened storage must keep the persisted compaction usage",
      );
      const reopenedUsage = await reopened.usage();
      assert.ok(
        (reopenedUsage.models[key]?.totalTokens ?? 0) >= afterTokens,
        "reopened project usage must still include the compaction tokens",
      );
    } finally {
      await reopened.close().catch(() => undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("reconfigureWorkspaces updates router cwd, rediscovery, and spawn_worker default cwd", async () => {
  const fixture = await openFixture({ codemode: { mode: "inline" } });
  const dir2 = await mkdtemp(join(tmpdir(), "eevee-core-workspace-"));
  try {
    await writeFile(join(dir2, "AGENTS.md"), "dir2-workspace-instructions-marker");

    let firstSystem = "";
    let secondSystem = "";
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      const serialized = contextText(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("second-prompt")) {
          secondSystem = serialized;
          return fauxAssistantMessage("second answer");
        }
        if (text.includes("first-prompt")) {
          firstSystem = serialized;
          return fauxAssistantMessage("first answer");
        }
        if (text.includes("spawn-after-reconfigure")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "mover",
                prompt: "mover-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("mover-task")) {
          return fauxAssistantMessage("mover final report");
        }
        if (text.includes("Worker mover")) {
          return fauxAssistantMessage("router saw mover handoff");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated mover");
      }
      throw new Error(`unexpected model context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const first = await fixture.project.send("first-prompt");
    await first.wait(BACKGROUND_CONTEXT);
    assert.ok(firstSystem.length > 0, "first prompt must reach the model");
    assert.equal(
      firstSystem.includes("dir2-workspace-instructions-marker"),
      false,
      "first prompt must not see dir2 context",
    );

    await assert.rejects(
      fixture.project.reconfigureWorkspaces([]),
      RangeError,
      "empty workspaces must be rejected",
    );

    await fixture.project.reconfigureWorkspaces([dir2]);
    const agent = await fixture.project.root.agent(BACKGROUND_CONTEXT);
    assert.equal(agent.cwd, resolve(dir2), "router cwd must switch to the new primary workspace");

    const second = await fixture.project.send("second-prompt");
    await second.wait(BACKGROUND_CONTEXT);
    assert.ok(
      secondSystem.includes("dir2-workspace-instructions-marker"),
      "next prompt must discover dir2/AGENTS.md",
    );

    const spawn = await fixture.project.send("spawn-after-reconfigure");
    await spawn.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => (await fixture.project.workers()).length === 1, "spawned mover");
    const worker = (await fixture.project.workers())[0];
    assert.ok(worker !== undefined);
    assert.equal(
      worker.cwd,
      resolve(dir2),
      "spawn_worker must default to the reconfigured primary workspace",
    );
  } finally {
    await closeFixture(fixture);
    await rm(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
