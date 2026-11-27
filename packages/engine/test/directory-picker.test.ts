import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { EeveeApiError, EeveeClient } from "@eevee/protocol";
import {
  createDirectoryPicker,
  Engine,
  EngineError,
  type PickerCommandRunner,
  startEngineHttpServer,
} from "../src/index.ts";

test("createDirectoryPicker handles Windows selection, cancel, and busy lock", async () => {
  let resolveSlow: (() => void) | undefined;
  let calls = 0;
  const runner: PickerCommandRunner = async (command, args, opts) => {
    calls += 1;
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-EncodedCommand"));
    if (calls === 1) {
      assert.equal(opts.env.EEVEE_PICKER_TITLE, "Choose Project");
      return { stdout: "C:\\Users\\Dev\\Repo\r\n", stderr: "", code: 0 };
    }
    if (calls === 2) {
      return { stdout: "", stderr: "", code: 2 };
    }
    await new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    return { stdout: "C:\\Work", stderr: "", code: 0 };
  };

  const picker = createDirectoryPicker({ platform: "win32", env: {}, runner });
  assert.deepEqual(await picker.pick({ title: "Choose Project" }), {
    path: "C:\\Users\\Dev\\Repo",
    cancelled: false,
  });
  assert.deepEqual(await picker.pick(), { path: null, cancelled: true });

  const first = picker.pick();
  await assert.rejects(
    () => picker.pick(),
    (err: unknown) =>
      err instanceof EngineError && err.code === "picker_busy" && err.status === 409,
  );
  resolveSlow?.();
  assert.deepEqual(await first, { path: "C:\\Work", cancelled: false });
});

test("createDirectoryPicker handles macOS selection and user cancel", async () => {
  let mode: "ok" | "cancel" = "ok";
  const runner: PickerCommandRunner = async (command, args) => {
    assert.equal(command, "osascript");
    assert.equal(args[0], "-e");
    if (mode === "ok") {
      return { stdout: "/Users/dev/project/\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "execution error: User canceled. (-128)", code: 1 };
  };

  const picker = createDirectoryPicker({ platform: "darwin", env: {}, runner });
  assert.deepEqual(await picker.pick(), { path: "/Users/dev/project", cancelled: false });

  mode = "cancel";
  assert.deepEqual(await picker.pick(), { path: null, cancelled: true });
});

test("createDirectoryPicker handles Linux zenity, kdialog fallback, and headless environments", async () => {
  const headless = createDirectoryPicker({
    platform: "linux",
    env: {},
    runner: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  await assert.rejects(
    () => headless.pick(),
    (err: unknown) =>
      err instanceof EngineError && err.code === "picker_unavailable" && err.status === 501,
  );

  const calls: string[] = [];
  const kdialogPicker = createDirectoryPicker({
    platform: "linux",
    env: { DISPLAY: ":0" },
    runner: async (command) => {
      calls.push(command);
      if (command === "zenity") return { stdout: "", stderr: "", code: null, errorCode: "ENOENT" };
      return { stdout: "/home/dev/app\n", stderr: "", code: 0 };
    },
  });
  assert.deepEqual(await kdialogPicker.pick(), { path: "/home/dev/app", cancelled: false });
  assert.deepEqual(calls, ["zenity", "kdialog"]);
});

test("POST /fs/pick-directory serves native picker over HTTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-picker-http-"));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await Engine.open({ dataDir: dir, models });
  const picker = createDirectoryPicker({
    platform: "darwin",
    env: {},
    runner: async () => ({ stdout: "/tmp/picked-repo/\n", stderr: "", code: 0 }),
  });
  const server = await startEngineHttpServer(engine, {
    port: 0,
    token: "secret",
    webDistDir: false,
    directoryPicker: picker,
  });
  try {
    const client = new EeveeClient({ baseUrl: server.url, token: "secret" });
    const picked = await client.pickDirectory({ title: "Pick folder" });
    assert.deepEqual(picked, { path: "/tmp/picked-repo", cancelled: false });

    const unauth = new EeveeClient({ baseUrl: server.url, token: "wrong" });
    await assert.rejects(
      () => unauth.pickDirectory(),
      (err: unknown) => err instanceof EeveeApiError && err.status === 401,
    );
  } finally {
    await server.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
