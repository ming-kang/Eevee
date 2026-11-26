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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type Agent, AgentDoc, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openProject, type ProjectHandle, type ToolPolicy } from "../src/index.ts";

const MODEL_ID = "faux-1";

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

function messageText(message: Message): string {
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
    return contentText(message.content);
  }
  return "";
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

async function renderAgentSections(project: ProjectHandle, conversation: Conversation) {
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  const sections: Record<string, string | undefined> = {};
  for (const key of ["tools", "rules", "skills", "codemode"]) {
    const entry = agent.sections.find((section) => section.key === key);
    sections[key] = await entry?.render(
      {
        conversationId: conversation.id,
        agent,
        env: undefined,
        shown: {},
        read: project.harness,
      },
      BACKGROUND_CONTEXT,
    );
  }
  return { agent, sections };
}

function toolNames(agent: Agent): string[] {
  return agent.tools.map((tool) => tool.name);
}

test("live tool policy reconfigures Workers, prompts, codemode modes, and newly spawned Workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-tool-policy-"));
  await mkdir(join(dir, ".pi", "skills", "demo"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\n",
  );

  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const brain: FauxResponseFactory = (context) => {
    const last = lastMessage(context);
    if (last?.role === "user") {
      const text = messageText(last);
      if (text.includes("spawn-first") || text.includes("spawn-second")) {
        const second = text.includes("spawn-second");
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", {
              name: second ? "second" : "first",
              prompt: second ? "second-worker" : "first-worker",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
    }
    return fauxAssistantMessage("ack");
  };
  faux.setResponses(Array.from({ length: 40 }, () => brain));

  let policy: ToolPolicy | undefined;
  let project: ProjectHandle | undefined;
  try {
    project = await openProject(new MemoryStorage(), {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      codemode: { mode: "inline", models: false },
      toolPolicy: () => policy,
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
    });
    const p = project;

    const firstSubmission = await p.send("spawn-first");
    await firstSubmission.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => (await p.workers()).length === 1, "first Worker");
    const firstWorker = (await p.workers())[0];
    assert.ok(firstWorker);
    const firstConversation = await p.harness.conversation(
      firstWorker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(firstConversation);

    const initial = await renderAgentSections(p, firstConversation);
    for (const name of ["read", "write", "edit", "bash", "codemode"]) {
      assert.ok(toolNames(initial.agent).includes(name), `initial Worker offers ${name}`);
    }
    for (const name of ["powershell", "ls", "find", "grep"]) {
      assert.equal(toolNames(initial.agent).includes(name), false, `default disables ${name}`);
      assert.equal(
        initial.agent.callable.some((tool) => tool.name === name),
        false,
        `default removes ${name} from callable tools`,
      );
    }
    assert.ok(initial.sections.tools?.includes("- bash:"));
    assert.equal(initial.sections.tools?.includes("- powershell:"), false);
    assert.ok(initial.sections.skills?.includes("Use read to load"));

    policy = {
      router: { ls: false },
      worker: { bash: false, powershell: true, grep: true },
    };
    await p.reconfigureTools();
    const toggled = await renderAgentSections(p, firstConversation);
    assert.equal(toolNames(toggled.agent).includes("bash"), false);
    assert.ok(toolNames(toggled.agent).includes("powershell"));
    assert.ok(toolNames(toggled.agent).includes("grep"));
    assert.equal(
      toggled.agent.callable.some((tool) => tool.name === "bash"),
      false,
    );
    assert.ok(toggled.sections.tools?.includes("- powershell:"));
    assert.ok(toggled.sections.tools?.includes("- grep:"));
    assert.equal(toggled.sections.tools?.includes("- bash:"), false);
    assert.ok(toggled.sections.rules?.includes("$null"));
    assert.equal(
      toggled.sections.rules?.includes("Use bash for builds, tests, and system commands."),
      false,
    );
    const router = await renderAgentSections(p, p.root);
    assert.equal(toolNames(router.agent).includes("ls"), false);
    assert.equal(router.sections.tools?.includes("- ls:"), false);

    policy = { ...policy, codemode: { mode: "off" } };
    await p.reconfigureTools();
    const off = await renderAgentSections(p, firstConversation);
    assert.equal(toolNames(off.agent).includes("codemode"), false);
    assert.equal(off.sections.codemode, undefined);
    assert.equal(
      off.agent.extensions.some((extension) => extension.name === "eevee.codemode"),
      false,
    );
    const toolSearch = off.agent.tools.find((tool) => tool.name === "tool_search");
    assert.ok(toolSearch);
    await firstConversation.configure({ modelTools: { add: [toolSearch] } }, BACKGROUND_CONTEXT);
    await p.reconfigureTools();
    assert.deepEqual(
      (await p.harness.snapshot(AgentDoc, firstConversation.id, BACKGROUND_CONTEXT))?.modelTools,
      { add: ["tool_search"] },
    );

    policy = { ...policy, codemode: { mode: "only", inlineBudget: 12_000 } };
    await p.reconfigureTools();
    const only = await renderAgentSections(p, firstConversation);
    assert.deepEqual(toolNames(only.agent), ["codemode"]);
    assert.ok(only.agent.callable.some((tool) => tool.name === "read"));
    assert.ok(only.agent.callable.some((tool) => tool.name === "grep"));
    assert.ok(only.sections.tools?.includes("- codemode:"));
    assert.equal(only.sections.tools?.includes("- read:"), false);
    assert.ok(only.sections.rules?.includes("Promise.allSettled"));
    assert.equal(only.sections.rules?.includes("Use read to inspect files"), false);
    assert.ok(only.sections.skills?.includes("Use codemode (tools.read) to load"));
    assert.ok(only.sections.codemode?.includes("### `read`"));
    assert.ok(only.sections.codemode?.includes("### `grep`"));

    policy = { ...policy, codemode: { mode: "only", inlineBudget: 0 } };
    await p.reconfigureTools();
    const zeroBudget = await renderAgentSections(p, firstConversation);
    assert.ok(zeroBudget.sections.codemode?.includes("Some tools are not listed"));
    assert.equal(zeroBudget.sections.codemode?.includes("### `read`"), false);

    policy = { ...policy, codemode: { mode: "on", inlineBudget: 12_000 } };
    await p.reconfigureTools();
    const on = await renderAgentSections(p, firstConversation);
    assert.ok(toolNames(on.agent).includes("read"));
    assert.ok(toolNames(on.agent).includes("codemode"));
    assert.equal(toolNames(on.agent).includes("bash"), false);
    assert.ok(on.sections.skills?.includes("Use read to load"));
    assert.equal(
      (await p.harness.snapshot(AgentDoc, firstConversation.id, BACKGROUND_CONTEXT))?.modelTools,
      undefined,
    );

    const secondSubmission = await p.send("spawn-second");
    await secondSubmission.wait(BACKGROUND_CONTEXT);
    await waitFor(async () => (await p.workers()).length === 2, "second Worker");
    const secondWorker = (await p.workers()).find((worker) => worker.id !== firstWorker.id);
    assert.ok(secondWorker);
    const secondConversation = await p.harness.conversation(
      secondWorker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(secondConversation);
    const inherited = await renderAgentSections(p, secondConversation);
    assert.equal(toolNames(inherited.agent).includes("bash"), false);
    assert.ok(toolNames(inherited.agent).includes("powershell"));
    assert.ok(toolNames(inherited.agent).includes("grep"));
    assert.equal(toolNames(inherited.agent).includes("ls"), false);
    assert.ok(toolNames(inherited.agent).includes("codemode"));
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
