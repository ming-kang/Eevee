import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import {
  createCodingToolsExtension,
  createReadonlyToolsExtension,
} from "../src/extensions/coding-tools/index.ts";
import { createShellPathsExtension } from "../src/extensions/shell-paths/index.ts";
import { createTestHarness } from "./harness.ts";

type ToolResultEntry = {
  toolName?: string;
  isError?: boolean;
  content?: unknown;
};

async function toolResults(conversation: Conversation): Promise<ToolResultEntry[]> {
  const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
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

test("harness drives write then read through the coding-tools extension", async () => {
  const th = await createTestHarness({ extensions: [createCodingToolsExtension()] });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "note.txt", content: "roundtrip content" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(await readFile(join(th.dir, "note.txt"), "utf8"), "roundtrip content");
    const results = await toolResults(conversation);
    const write = results.find((entry) => entry.toolName === "write");
    const read = results.find((entry) => entry.toolName === "read");
    assert.equal(write?.isError, false);
    assert.equal(read?.isError, false);
    assert.ok(resultText(read ?? {}).includes("roundtrip content"));
  } finally {
    await th.cleanup();
  }
});

test("bash nonzero exit is an error result that keeps its output", async () => {
  const th = await createTestHarness({ extensions: [createCodingToolsExtension()] });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo out-before-fail && exit 3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, true);
    assert.ok(resultText(bash).includes("out-before-fail"));
  } finally {
    await th.cleanup();
  }
});

test("bash timeout is an error result rather than a multi-hour hang", async () => {
  const th = await createTestHarness({ extensions: [createCodingToolsExtension()] });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", timeout: 1 })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    const started = Date.now();
    await submission.wait(BACKGROUND_CONTEXT);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20000, `took ${elapsed}ms`);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, true);
  } finally {
    await th.cleanup();
  }
});

test("ls/find/grep run through the readonly-tools extension over the harness", async () => {
  const th = await createTestHarness({ extensions: [createReadonlyToolsExtension()] });
  try {
    await mkdir(join(th.dir, "src"), { recursive: true });
    await writeFile(join(th.dir, "src", "a.ts"), "needle line");
    await writeFile(join(th.dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(th.dir, "ignored.txt"), "needle hidden");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const grep = results.find((entry) => entry.toolName === "grep");
    assert.ok(grep);
    assert.equal(grep.isError, false);
    const text = resultText(grep);
    assert.ok(text.includes("src/a.ts:1: needle line"));
    assert.ok(!text.includes("ignored.txt"));
  } finally {
    await th.cleanup();
  }
});

test("shell-paths beforeTool rewrites MSYS mount paths in harness tool calls", {
  skip: process.platform !== "win32",
}, async () => {
  let th: Awaited<ReturnType<typeof createTestHarness>> | undefined;
  try {
    const probe = await createTestHarness();
    const targetRoot = probe.dir;
    await probe.cleanup();
    th = await createTestHarness({
      extensions: [
        createCodingToolsExtension(),
        createShellPathsExtension({
          readMounts: async () => [
            { point: "/tmp", target: targetRoot },
            { point: "/", target: "C:\\" },
          ],
        }),
      ],
    });
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "/tmp/via-mount/x.txt", content: "mount write" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const written = await readFile(join(targetRoot, "via-mount", "x.txt"), "utf8").catch(
      () => undefined,
    );
    assert.equal(written, "mount write");
    const results = await toolResults(conversation);
    const write = results.find((entry) => entry.toolName === "write");
    assert.equal(write?.isError, false);
  } finally {
    await th?.cleanup();
  }
});

function bashStdout(command: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile("bash.exe", ["-c", command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolvePromise(error ? undefined : stdout.trim());
    });
  });
}

test("shell-paths default mount probe rewrites /tmp using real Git Bash mounts", {
  skip: process.platform !== "win32",
}, async (t) => {
  const windowsTmp = await bashStdout("cygpath -w /tmp");
  if (windowsTmp === undefined || windowsTmp === "") {
    t.skip("bash.exe is unavailable");
    return;
  }
  const name = `eevee-shell-paths-${randomUUID()}`;
  const expectedDir = join(windowsTmp, name);
  const fallbackDir = resolve("/tmp", name);
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createShellPathsExtension()],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: `/tmp/${name}/x.txt`, content: "real mount write" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const written = await readFile(join(expectedDir, "x.txt"), "utf8").catch(() => undefined);
    assert.equal(written, "real mount write");
  } finally {
    await th.cleanup();
    await rm(expectedDir, { recursive: true, force: true });
    if (fallbackDir !== expectedDir) await rm(fallbackDir, { recursive: true, force: true });
  }
});

function bmpBytes(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const fileSize = 54 + dataSize;
  const bmp = Buffer.alloc(fileSize);
  bmp.write("BM", 0);
  bmp.writeUInt32LE(fileSize, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(dataSize, 34);
  for (let i = 54; i < fileSize; i += 3) {
    bmp[i] = 30;
    bmp[i + 1] = 120;
    bmp[i + 2] = 200;
  }
  return bmp;
}

test("read prepares images through Photon when reading a BMP", async () => {
  const th = await createTestHarness({ extensions: [createCodingToolsExtension()] });
  try {
    await writeFile(join(th.dir, "pixel.bmp"), bmpBytes(4, 4));
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "pixel.bmp" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const read = results.find((entry) => entry.toolName === "read");
    assert.ok(read);
    assert.equal(read.isError, false);
    const serialized = JSON.stringify(read.content);
    assert.ok(
      serialized.includes("image/png"),
      `expected a converted PNG image part, got: ${serialized.slice(0, 200)}`,
    );
  } finally {
    await th.cleanup();
  }
});
