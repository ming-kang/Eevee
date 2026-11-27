import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import { EeveeClient, filePartInner, MAX_ATTACHMENT_BYTES, parseFilePart } from "@eevee/protocol";
import {
  buildUserMessageContent,
  Engine,
  EngineError,
  resolveFileMentions,
  resolveInsideWorkspace,
  searchWorkspaceFiles,
  startEngineHttpServer,
} from "../src/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-ws-files-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("searchWorkspaceFiles respects ignore rules, skips vendor dirs, and ranks matches", async () => {
  await withTempDir(async (dir) => {
    const ws1 = join(dir, "app");
    const ws2 = join(dir, "lib");
    await mkdir(join(ws1, "src"), { recursive: true });
    await mkdir(join(ws1, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(ws1, "ignored-dir"), { recursive: true });
    await mkdir(join(ws2, "src"), { recursive: true });

    await writeFile(join(ws1, ".gitignore"), "ignored-dir/\n*.secret\n", "utf8");
    await writeFile(join(ws1, "src", "router.ts"), "export const r = 1;\n", "utf8");
    await writeFile(join(ws1, "src", "my-router-helper.ts"), "export const h = 2;\n", "utf8");
    await writeFile(join(ws1, "src", "notes.secret"), "top-secret", "utf8");
    await writeFile(join(ws1, "node_modules", "pkg", "router.js"), "ignored", "utf8");
    await writeFile(join(ws1, "ignored-dir", "router.ts"), "ignored", "utf8");
    await writeFile(join(ws2, "src", "utils.ts"), "export const u = 3;\n", "utf8");

    const single = await searchWorkspaceFiles([ws1], "router", 10);
    assert.deepEqual(
      single.map((f) => f.path),
      ["src/router.ts", "src/my-router-helper.ts"],
    );
    assert.equal(single[0]?.label, "src/router.ts");
    assert.ok((single[0]?.size ?? 0) > 0);

    const multi = await searchWorkspaceFiles([ws1, ws2], "", 10);
    const labels = multi.map((f) => f.label);
    assert.ok(labels.includes("app/src/router.ts"));
    assert.ok(labels.includes("lib/src/utils.ts"));
    assert.ok(!labels.some((label) => label.includes("secret") || label.includes("ignored-dir")));
  });
});

test("resolveInsideWorkspace rejects traversal and escaping symlinks", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "repo");
    const outside = join(dir, "outside.txt");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "ok.txt"), "ok", "utf8");
    await writeFile(outside, "secret", "utf8");

    const resolved = await resolveInsideWorkspace(ws, "ok.txt");
    assert.ok(resolved.endsWith("ok.txt"));

    await assert.rejects(
      () => resolveInsideWorkspace(ws, "../outside.txt"),
      (err: unknown) => err instanceof EngineError && err.code === "invalid_path",
    );
    await assert.rejects(
      () => resolveInsideWorkspace(ws, outside),
      (err: unknown) => err instanceof EngineError && err.code === "invalid_path",
    );

    const linkPath = join(ws, "escape.txt");
    try {
      await symlink(outside, linkPath);
    } catch {
      return;
    }
    await assert.rejects(
      () => resolveInsideWorkspace(ws, "escape.txt"),
      (err: unknown) => err instanceof EngineError && err.code === "invalid_path",
    );
  });
});

test("resolveFileMentions parses file paths, quotes spaces, and ignores refs and emails", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "repo");
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "index.ts"), "console.log(1);\n", "utf8");
    await writeFile(join(ws, "src", "my doc.md"), "# Doc\n", "utf8");

    const mentions = await resolveFileMentions(
      'Check @src/index.ts, @"src/my doc.md" and ask @w1 about @t2 or mail dev@example.com',
      [ws],
    );
    assert.deepEqual(mentions, [
      { workspace: 0, path: "src/index.ts" },
      { workspace: 0, path: "src/my doc.md" },
    ]);
  });
});

test("buildUserMessageContent handles inline images, text files, workspace files, and @ mentions", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "repo");
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const plain = await buildUserMessageContent({ text: "hello", workspaces: [ws] });
    assert.equal(plain, "hello");

    const pngBase64 = Buffer.from([137, 80, 78, 71]).toString("base64");
    const noteBase64 = Buffer.from("note content", "utf8").toString("base64");

    const parts = await buildUserMessageContent({
      text: "Look at @src/a.ts",
      workspaces: [ws],
      attachments: [
        { kind: "inline", name: "shot.png", mimeType: "image/png", data: pngBase64 },
        { kind: "inline", name: "note.txt", mimeType: "text/plain", data: noteBase64 },
        { kind: "workspace", workspace: 0, path: "src/a.ts" },
      ],
    });

    assert.ok(Array.isArray(parts));
    assert.equal(parts.length, 4);
    assert.deepEqual(parts[0], { type: "image", data: pngBase64, mimeType: "image/png" });

    assert.equal(parts[1]?.type, "text");
    const noteMeta = parseFilePart(parts[1]?.type === "text" ? parts[1].text : "");
    assert.equal(noteMeta?.name, "note.txt");
    assert.equal(filePartInner(parts[1]?.type === "text" ? parts[1].text : ""), "note content");

    assert.equal(parts[2]?.type, "text");
    const wsMeta = parseFilePart(parts[2]?.type === "text" ? parts[2].text : "");
    assert.equal(wsMeta?.path, "src/a.ts");
    assert.equal(
      filePartInner(parts[2]?.type === "text" ? parts[2].text : ""),
      "export const a = 1;\n",
    );

    assert.deepEqual(parts[3], { type: "text", text: "Look at @src/a.ts" });

    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString("base64");
    await assert.rejects(
      () =>
        buildUserMessageContent({
          text: "",
          workspaces: [ws],
          attachments: [
            { kind: "inline", name: "huge.png", mimeType: "image/png", data: oversized },
          ],
        }),
      (err: unknown) => err instanceof EngineError && err.code === "attachment_too_large",
    );
  });
});

test("HTTP API lists project files and accepts multimodal payloads larger than 2 MiB", async () => {
  await withTempDir(async (dir) => {
    const dataDir = join(dir, "data");
    const ws = join(dir, "repo");
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "app.ts"), "export const ok = true;\n", "utf8");

    const seenUserMessages: Message[] = [];
    const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
    faux.setResponses([
      (ctx) => {
        const last = ctx.messages.findLast((m) => m.role === "user");
        if (last) seenUserMessages.push(last);
        return fauxAssistantMessage("received");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const engine = await Engine.open({
      dataDir,
      models,
      defaultModelSlots: { router: { provider: faux.provider.id, modelId: "faux-1" } },
    });
    const server = await startEngineHttpServer(engine, {
      port: 0,
      token: "test-token",
      webDistDir: false,
    });
    try {
      const client = new EeveeClient({ baseUrl: server.url, token: "test-token" });
      const { project } = await client.createProject({ title: "Demo", workspaces: [ws] });

      const listed = await client.listProjectFiles(project.id, { q: "app", limit: 10 });
      assert.equal(listed.files.length, 1);
      assert.equal(listed.files[0]?.path, "src/app.ts");

      // >2 MiB raw image (~2.9 MiB base64) to verify per-route message body cap
      const largeImageBase64 = Buffer.alloc(2_200_000, 0x41).toString("base64");
      const sent = await client.sendMessage(project.id, "router", {
        text: "Review @src/app.ts",
        attachments: [
          { kind: "inline", name: "screen.png", mimeType: "image/png", data: largeImageBase64 },
        ],
      });
      assert.ok(sent.submissionId >= 1);

      const deadline = Date.now() + 10_000;
      while (seenUserMessages.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(seenUserMessages.length, 1);
      const userMsg = seenUserMessages[0];
      assert.equal(userMsg?.role, "user");
      assert.ok(Array.isArray(userMsg.content));
      assert.equal(userMsg.content[0]?.type, "image");
      assert.equal(userMsg.content[1]?.type, "text");
      assert.equal(parseFilePart(userMsg.content[1]?.text ?? "")?.path, "src/app.ts");
      assert.deepEqual(userMsg.content[2], { type: "text", text: "Review @src/app.ts" });
    } finally {
      await server.close();
      await engine.close();
    }
  });
});
