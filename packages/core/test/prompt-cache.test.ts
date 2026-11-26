import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type SystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type Conversation, type EntryRecord, SystemEntry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createMcpHub } from "@eevee/agent";
import { openProject, type ProjectHandle, ROUTER_PREAMBLE, WORKER_PREAMBLE } from "../src/index.ts";

const MODEL_ID = "faux-1";

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

function messageText(message: Message): string {
  if (message.role === "user") return contentText(message.content);
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "toolResult") return contentText(message.content);
  return "";
}

async function systemEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries(
    { order: "ascending" },
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.filter((entry) => SystemEntry.is(entry));
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

test("Router and Worker enforce exact prompt-cache section ordering, concise preambles, and minimal volatile deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-prompt-cache-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  await writeFile(join(dir, "AGENTS.md"), "Project context rules.");
  await mkdir(join(dir, ".agents", "skills", "demo"), { recursive: true });
  await writeFile(
    join(dir, ".agents", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\n",
  );

  const mcpHub = createMcpHub({
    servers: [
      {
        name: "docs",
        config: { command: "echo", description: "Demo MCP docs", exposure: "deferred" },
      },
    ],
  });

  let projectMemory = "Initial memory fact.";
  const modelProfiles = "fast: faux-1";
  const routerContexts: TranscriptContext[] = [];
  const workerContexts: TranscriptContext[] = [];

  let project: ProjectHandle | undefined;
  try {
    project = await openProject(storage, {
      cwd: dir,
      title: "Prompt Cache Project",
      workspaces: [dir],
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      mcpHub,
      codemode: { mode: "inline", models: false },
      projectMemory: () => projectMemory,
      modelProfiles: () => modelProfiles,
      baseExtensionOptions: { globalDir: join(dir, "no-global"), userHomeDir: null },
    });

    const brain: FauxResponseFactory = (context) => {
      const firstSys = context.messages[0] as SystemMessage | undefined;
      const isWorker = firstSys?.sections?.["worker-role"] !== undefined;
      if (isWorker) workerContexts.push(context);
      else routerContexts.push(context);

      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("router-turn-1")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "cachew", prompt: "worker-turn-1" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-turn-1")) return fauxAssistantMessage("worker-done-1");
        if (text.includes("worker-done-1")) return fauxAssistantMessage("router-saw-worker-1");
        if (text.includes("router-turn-2")) return fauxAssistantMessage("router-done-2");
        if (text.includes("worker-turn-2")) return fauxAssistantMessage("worker-done-2");
        if (text.includes("worker-done-2")) return fauxAssistantMessage("router-saw-worker-2");
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("spawned cachew");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    faux.setResponses(Array.from({ length: 20 }, () => brain));

    const p = project;
    const t1 = await p.send("router-turn-1");
    await t1.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => {
      const page = await p.root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
      return page.items.some((entry) => {
        const msg = entry.model?.[0];
        return (
          msg?.role === "assistant" && contentText(msg.content).includes("router-saw-worker-1")
        );
      });
    }, "worker handoff observed by router");
    await project.root.waitForIdle(BACKGROUND_CONTEXT);

    const w1 = (await project.workers())[0];
    assert.ok(w1);
    const workerConv = await project.harness.conversation(w1.conversationId, BACKGROUND_CONTEXT);
    assert.ok(workerConv);

    const routerSysEntries1 = await systemEntries(project.root);
    const routerBaseline = routerSysEntries1[0]?.model?.[0] as SystemMessage;
    const routerKeys = Object.keys(routerBaseline.sections ?? {});
    assert.deepEqual(routerKeys, [
      "preamble",
      "tools",
      "rules",
      "cwd",
      "agent-context",
      "skills",
      "codemode",
      "memory",
      "mcp_servers",
      "project",
      "router-role",
      "model-profiles",
      "project-memory",
      "board-overview",
    ]);
    assert.equal(routerKeys.at(-1), "board-overview");
    assert.equal(routerBaseline.sections?.preamble, ROUTER_PREAMBLE);
    assert.equal(routerBaseline.sections?.instructions, undefined);
    assert.ok(routerBaseline.sections?.tools?.includes("spawn_worker"));
    assert.ok(routerBaseline.sections?.rules?.includes("self-contained briefing"));
    assert.ok(routerBaseline.sections?.rules?.includes("final decisions"));

    // Verify board-overview change between router turn 1 and handoff turn emitted only a minimal delta
    const boardOnlyDelta = routerSysEntries1.at(-1)?.model?.[0] as SystemMessage | undefined;
    assert.ok(routerSysEntries1.length >= 2);
    assert.deepEqual(Object.keys(boardOnlyDelta?.sections ?? {}), ["board-overview"]);
    assert.equal(
      Object.values(boardOnlyDelta?.sections ?? {}).some((value) => value === null),
      false,
    );

    const workerSysEntries1 = await systemEntries(workerConv);
    const workerBaseline = workerSysEntries1[0]?.model?.[0] as SystemMessage;
    const workerKeys = Object.keys(workerBaseline.sections ?? {});
    assert.deepEqual(workerKeys, [
      "preamble",
      "tools",
      "rules",
      "cwd",
      "agent-context",
      "skills",
      "codemode",
      "worker-role",
      "project-memory",
      "mcp_servers",
    ]);
    assert.equal(workerKeys.at(-1), "mcp_servers");
    assert.equal(workerBaseline.sections?.preamble, WORKER_PREAMBLE);
    assert.equal(workerBaseline.sections?.instructions, undefined);
    assert.equal(workerBaseline.sections?.["worker-role"]?.includes("You are"), false);
    assert.ok(workerBaseline.sections?.["worker-role"]?.includes("message_router"));
    assert.ok(workerBaseline.sections?.rules?.includes("Never poll tasks"));

    // Modify projectMemory -> emits minimal 1-section patch without touching earlier static sections
    const routerSysCountBefore = (await systemEntries(project.root)).length;
    const workerSysCountBefore = (await systemEntries(workerConv)).length;
    projectMemory = "Updated memory fact.";

    const t2 = await project.send("router-turn-2");
    await t2.wait(BACKGROUND_CONTEXT);
    const routerSysAfter = await systemEntries(project.root);
    assert.equal(routerSysAfter.length, routerSysCountBefore + 1);
    const routerMemDelta = routerSysAfter.at(-1)?.model?.[0] as SystemMessage;
    assert.deepEqual(Object.keys(routerMemDelta.sections ?? {}), ["project-memory"]);

    const w2 = await project.send("w1", "worker-turn-2");
    await w2.wait(BACKGROUND_CONTEXT);
    const workerSysAfter = await systemEntries(workerConv);
    assert.equal(workerSysAfter.length, workerSysCountBefore + 1);
    const workerMemDelta = workerSysAfter.at(-1)?.model?.[0] as SystemMessage;
    assert.deepEqual(Object.keys(workerMemDelta.sections ?? {}), ["project-memory"]);
  } finally {
    await project?.close();
    await mcpHub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("custom routerInstructions and workerInstructions render inside router-role and worker-role keeping volatile tails last", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-custom-role-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  let project: ProjectHandle | undefined;
  try {
    project = await openProject(storage, {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      routerInstructions: "Custom Router directive.",
      workerInstructions: "Custom Worker directive.",
      codemode: false,
      baseExtensionOptions: { globalDir: join(dir, "no-global"), userHomeDir: null },
    });

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "customw", prompt: "run-custom" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-custom")) return fauxAssistantMessage("worker-ok");
        if (text.includes("worker-ok")) return fauxAssistantMessage("router-ok");
      }
      if (last?.role === "toolResult") return fauxAssistantMessage("spawned");
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    faux.setResponses(Array.from({ length: 10 }, () => brain));

    const p = project;
    const sub = await p.send("start");
    await sub.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => (await p.workers()).length === 1, "worker spawned");
    const w1 = (await p.workers())[0];
    assert.ok(w1);
    const workerConv = await project.harness.conversation(w1.conversationId, BACKGROUND_CONTEXT);
    assert.ok(workerConv);

    await waitFor(async () => (await systemEntries(workerConv)).length >= 1, "worker system entry");

    const routerSys = (await systemEntries(project.root))[0]?.model?.[0] as SystemMessage;
    assert.ok(routerSys.sections?.["router-role"]?.includes("Custom Router directive."));
    assert.equal(routerSys.sections?.instructions, undefined);
    assert.equal(Object.keys(routerSys.sections ?? {}).at(-1), "board-overview");

    const workerSys = (await systemEntries(workerConv))[0]?.model?.[0] as SystemMessage;
    assert.ok(workerSys.sections?.["worker-role"]?.includes("Custom Worker directive."));
    assert.equal(workerSys.sections?.instructions, undefined);
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
