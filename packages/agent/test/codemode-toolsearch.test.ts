import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { type Conversation, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
  createCodemodeExtension,
  createCodemodeHandle,
  InlineCodemodeSandbox,
} from "../src/extensions/codemode/index.ts";
import {
  createCodingToolsExtension,
  createReadonlyToolsExtension,
} from "../src/extensions/coding-tools/index.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createTestHarness } from "./harness.ts";

type ToolResultEntry = {
  toolName?: string;
  isError?: boolean;
  content?: unknown;
};

async function toolResults(conversation: Conversation): Promise<ToolResultEntry[]> {
  const entries = await conversation.entries(
    { order: "ascending" },
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const results: ToolResultEntry[] = [];
  for (const entry of entries.items) {
    if (entry.kind !== "pi.tool-result") continue;
    const model = (entry as { model?: unknown[] }).model;
    const first = Array.isArray(model) ? (model[0] as ToolResultEntry) : undefined;
    if (first !== undefined) results.push(first);
  }
  return results;
}

function resultText(result: ToolResultEntry): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

async function submitAndWait(conversation: Conversation): Promise<void> {
  const submission = await conversation.submit(
    { type: "input", content: "go" },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
}

function toolNamesOf(context: TranscriptContext): string[] {
  const names = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? []) names.delete(removed.name);
    for (const added of message.toolsAdded ?? []) names.add(added.name);
  }
  return [...names].sort();
}

function capturing(into: string[][], message: AssistantMessage): FauxResponseFactory {
  return (context) => {
    into.push(toolNamesOf(context));
    return message;
  };
}

function inlineSandbox(): InlineCodemodeSandbox {
  return new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
}

test("codemode runs JS in an InlineCodemodeSandbox calling tools.ls and tools.read", async () => {
  const sandbox = inlineSandbox();
  const th = await createTestHarness({
    extensions: [createReadonlyToolsExtension(), createCodemodeExtension({ sandbox })],
  });
  try {
    await writeFile(join(th.dir, "note.txt"), "roundtrip codemode");
    await writeFile(join(th.dir, "other.txt"), "other");
    const code = [
      'const listing = await tools.ls({ path: "." });',
      'const content = await tools.read({ path: "note.txt" });',
      'return "entries=" + listing.entries.join(",") + "|read=" + content.trim();',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    await submitAndWait(conversation);
    const results = await toolResults(conversation);
    const codemode = results.find((entry) => entry.toolName === "codemode");
    assert.ok(codemode, "expected a codemode tool result");
    assert.equal(codemode.isError, false);
    const text = resultText(codemode);
    assert.ok(text.includes("note.txt"), `expected ls entries in output: ${text}`);
    assert.ok(text.includes("other.txt"), `expected ls entries in output: ${text}`);
    assert.ok(text.includes("roundtrip codemode"), `expected read content in output: ${text}`);
  } finally {
    await th.cleanup();
    await sandbox.close();
  }
});

test("codemode runs in a worker-thread CodemodeSandbox through createCodemodeHandle", async () => {
  const handle = createCodemodeHandle();
  const th = await createTestHarness({
    extensions: [createReadonlyToolsExtension(), handle.extension],
  });
  try {
    assert.ok(handle.extension.tools?.some((tool) => tool.name === "codemode"));
    await writeFile(join(th.dir, "worker-note.txt"), "worker note content");
    const code = [
      'const content = await tools.read({ path: "worker-note.txt" });',
      'return "worker-read:" + content.trim();',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    await submitAndWait(conversation);
    const results = await toolResults(conversation);
    const codemode = results.find((entry) => entry.toolName === "codemode");
    assert.ok(codemode, "expected a codemode tool result");
    assert.equal(codemode.isError, false);
    assert.ok(
      resultText(codemode).includes("worker-read:worker note content"),
      `expected worker result text: ${resultText(codemode)}`,
    );
  } finally {
    await th.cleanup();
    await handle.close();
  }
});

test("createCodemodeHandle mode inline runs end-to-end and closes its sandbox", async () => {
  const handle = createCodemodeHandle({ mode: "inline" });
  assert.ok(handle.sandbox instanceof InlineCodemodeSandbox);
  const th = await createTestHarness({
    extensions: [createReadonlyToolsExtension(), handle.extension],
  });
  try {
    await writeFile(join(th.dir, "inline-note.txt"), "inline note content");
    const code = [
      'const content = await tools.read({ path: "inline-note.txt" });',
      'return "inline-read:" + content.trim();',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    await submitAndWait(conversation);
    const results = await toolResults(conversation);
    const codemode = results.find((entry) => entry.toolName === "codemode");
    assert.ok(codemode, "expected a codemode tool result");
    assert.equal(codemode.isError, false);
    assert.ok(
      resultText(codemode).includes("inline-read:inline note content"),
      `expected inline result text: ${resultText(codemode)}`,
    );
  } finally {
    await th.cleanup();
    await handle.close();
  }
});

test("createCodemodeHandle close() is a no-op for a caller-owned sandbox", async () => {
  const sandbox = inlineSandbox();
  const handle = createCodemodeHandle({ sandbox });
  assert.equal(handle.sandbox, sandbox);
  await handle.close();
  const result = await sandbox.execute('return "still-open"');
  assert.equal(result.ok, true);
  await sandbox.close();
});

test("codemode scripts cannot escape the conversation's tool selection", async () => {
  const readonlyTools = createReadonlyToolsExtension();
  const codingTools = createCodingToolsExtension();
  const sandbox = inlineSandbox();
  const codemode = createCodemodeExtension({ sandbox });
  const th = await createTestHarness({ extensions: [readonlyTools, codingTools, codemode] });
  try {
    const readonlyCode = [
      'let writeOutcome = "escaped";',
      "try {",
      '  await tools.write({ path: "escape.txt", content: "escape" });',
      "} catch (error) {",
      '  writeOutcome = "denied";',
      "}",
      'let bashOutcome = "escaped";',
      "try {",
      '  await tools.bash({ command: "echo escape" });',
      "} catch (error) {",
      '  bashOutcome = "denied";',
      "}",
      'return "write:" + ("write" in tools) + "/" + writeOutcome + "|bash:" + ("bash" in tools) + "/" + bashOutcome;',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: readonlyCode })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const readonly = await th.createConversation({ extensions: [readonlyTools, codemode] });
    await submitAndWait(readonly);
    const readonlyResults = await toolResults(readonly);
    const denied = readonlyResults.find((entry) => entry.toolName === "codemode");
    assert.ok(denied, "expected a codemode tool result");
    assert.equal(denied.isError, false);
    const deniedText = resultText(denied);
    assert.ok(
      deniedText.includes("write:false/denied"),
      `expected write to be unavailable: ${deniedText}`,
    );
    assert.ok(
      deniedText.includes("bash:false/denied"),
      `expected bash to be unavailable: ${deniedText}`,
    );
    const escaped = await th.env
      .fileInfo(join(th.dir, "escape.txt"), BACKGROUND_CONTEXT)
      .then((info) => info.ok);
    assert.equal(escaped, false, "escape.txt must not exist");

    const codingCode = [
      'await tools.write({ path: "written.txt", content: "codemode write ok" });',
      'const bash = await tools.bash({ command: "echo codemode-bash-ok" });',
      'return "write:" + ("write" in tools) + "|bash:" + bash.output.trim();',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: codingCode })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const coding = await th.createConversation({ extensions: [codingTools, codemode] });
    await submitAndWait(coding);
    const codingResults = await toolResults(coding);
    const allowed = codingResults.find((entry) => entry.toolName === "codemode");
    assert.ok(allowed, "expected a codemode tool result");
    assert.equal(allowed.isError, false);
    const allowedText = resultText(allowed);
    assert.ok(allowedText.includes("write:true"), `expected write available: ${allowedText}`);
    assert.ok(allowedText.includes("codemode-bash-ok"), `expected bash output: ${allowedText}`);
    const written = await th.env
      .fileInfo(join(th.dir, "written.txt"), BACKGROUND_CONTEXT)
      .then((info) => info.ok);
    assert.equal(written, true, "written.txt must exist");
  } finally {
    await th.cleanup();
    await sandbox.close();
  }
});

test("store() and load() persist values across codemode calls in one conversation", async () => {
  const sandbox = inlineSandbox();
  const th = await createTestHarness({
    extensions: [createReadonlyToolsExtension(), createCodemodeExtension({ sandbox })],
  });
  try {
    const storeCode = ['store("greeting", "hello-store");', 'return "stored";'].join("\n");
    const loadCode = ['const value = load("greeting");', 'return "loaded:" + value;'].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: storeCode })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("codemode", { code: loadCode })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    await submitAndWait(conversation);
    const results = await toolResults(conversation);
    const calls = results.filter((entry) => entry.toolName === "codemode");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.isError, false);
    assert.equal(calls[1]?.isError, false);
    assert.ok(
      resultText(calls[1] ?? {}).includes("loaded:hello-store"),
      `expected the stored value in the second call: ${resultText(calls[1] ?? {})}`,
    );
  } finally {
    await th.cleanup();
    await sandbox.close();
  }
});

test("tool_search loads a deferred tool the model then calls", async () => {
  const memoryRecall = defineTool({
    name: "memory_recall",
    description: "Recall facts and episodes from the long-term memory palace.",
    parameters: obj({ query: str({ description: "What to recall" }) }, { open: true }),
    deferred: true,
    execute: async (args) => ({
      output: [{ type: "text" as const, text: `recalled: ${args.query}` }],
    }),
  });
  const memoryExtension = defineExtension({ name: "test-memory", tools: [memoryRecall] });
  const th = await createTestHarness({
    extensions: [createToolSearchExtension(), memoryExtension],
  });
  try {
    const conversation = await th.createConversation();
    const before = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(
      before.deferred.some((tool) => tool.name === "memory_recall"),
      "memory_recall should start as a deferred tool",
    );
    assert.ok(
      !before.tools.some((tool) => tool.name === "memory_recall"),
      "memory_recall must not be offered initially",
    );
    assert.ok(
      before.tools.some((tool) => tool.name === "tool_search"),
      "tool_search should be offered initially",
    );

    const offered: string[][] = [];
    th.faux.setResponses([
      capturing(
        offered,
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "memory recall" })], {
          stopReason: "toolUse",
        }),
      ),
      capturing(
        offered,
        fauxAssistantMessage([fauxToolCall("memory_recall", { query: "favorite color" })], {
          stopReason: "toolUse",
        }),
      ),
      capturing(offered, fauxAssistantMessage("done")),
    ]);
    await submitAndWait(conversation);

    assert.ok(offered.length >= 2, `expected at least two requests, got ${offered.length}`);
    assert.ok(
      offered[0]?.includes("tool_search"),
      `first request should offer tool_search: ${offered[0]}`,
    );
    assert.ok(
      !offered[0]?.includes("memory_recall"),
      `first request must not offer memory_recall: ${offered[0]}`,
    );
    assert.ok(
      offered[1]?.includes("memory_recall"),
      `the request after tool_search must offer memory_recall: ${offered[1]}`,
    );

    const results = await toolResults(conversation);
    const search = results.find((entry) => entry.toolName === "tool_search");
    assert.ok(search, "expected a tool_search result");
    assert.equal(search.isError, false);
    assert.ok(
      resultText(search).includes("memory_recall"),
      `tool_search should list memory_recall: ${resultText(search)}`,
    );
    const recall = results.find((entry) => entry.toolName === "memory_recall");
    assert.ok(recall, "expected a memory_recall result");
    assert.equal(recall.isError, false);
    assert.ok(
      resultText(recall).includes("recalled: favorite color"),
      `expected the recall output: ${resultText(recall)}`,
    );

    const after = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(
      after.tools.some((tool) => tool.name === "memory_recall"),
      "memory_recall should stay offered after tool_search loaded it",
    );
  } finally {
    await th.cleanup();
  }
});

test("a deferred callers-tools tool hides from tool_search but scripts find and call it", async () => {
  const vaultUnlock = defineTool({
    name: "vault_unlock",
    description: "Unlock the secret vault with a passphrase and read its contents.",
    parameters: obj({ passphrase: str({ description: "The vault passphrase" }) }, { open: true }),
    deferred: true,
    callers: ["tools"],
    execute: async (args) => ({
      output: [{ type: "text" as const, text: `vault opened with ${args.passphrase}: gold coins` }],
    }),
  });
  const vaultExtension = defineExtension({ name: "test-vault", tools: [vaultUnlock] });
  const sandbox = inlineSandbox();
  const th = await createTestHarness({
    extensions: [createToolSearchExtension(), vaultExtension, createCodemodeExtension({ sandbox })],
  });
  try {
    const conversation = await th.createConversation();
    const before = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(
      before.callable.some((tool) => tool.name === "vault_unlock"),
      "vault_unlock should be callable by tools",
    );
    assert.ok(
      !before.deferred.some((tool) => tool.name === "vault_unlock"),
      "vault_unlock must not be a deferred tool the model may call",
    );
    assert.ok(
      !before.tools.some((tool) => tool.name === "vault_unlock"),
      "vault_unlock must not be offered to the model",
    );

    const code = [
      'const found = await searchTools("vault");',
      'const names = found.map((entry) => entry.name).join(",");',
      'const opened = await tools.vault_unlock({ passphrase: "open-sesame" });',
      'return "found=" + names + "|opened=" + opened;',
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "vault" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await submitAndWait(conversation);

    const results = await toolResults(conversation);
    const search = results.find((entry) => entry.toolName === "tool_search");
    assert.ok(search, "expected a tool_search result");
    assert.equal(search.isError, false);
    assert.ok(
      resultText(search).includes("No matching tools found"),
      `tool_search must not discover vault_unlock: ${resultText(search)}`,
    );

    const codemode = results.find((entry) => entry.toolName === "codemode");
    assert.ok(codemode, "expected a codemode tool result");
    assert.equal(codemode.isError, false);
    const text = resultText(codemode);
    assert.ok(text.includes("vault_unlock"), `searchTools() should discover vault_unlock: ${text}`);
    assert.ok(
      text.includes("gold coins"),
      `tools.vault_unlock() should run inside codemode: ${text}`,
    );
  } finally {
    await th.cleanup();
    await sandbox.close();
  }
});
