import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgram } from "./program.ts";

async function run(args: string[]): Promise<string[]> {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  const program = createProgram({
    start: record("start"),
    stop: record("stop"),
    status: record("status"),
    web: record("web"),
  });
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  }
  await program.parseAsync(args, { from: "user" });
  return calls;
}

test("a bare invocation starts the Engine, then opens the panel", async () => {
  assert.deepEqual(await run([]), ["start", "web"]);
});

test("each command does only its own thing", async () => {
  assert.deepEqual(await run(["start"]), ["start"]);
  assert.deepEqual(await run(["stop"]), ["stop"]);
  assert.deepEqual(await run(["status"]), ["status"]);
  assert.deepEqual(await run(["web"]), ["web"]);
});

test("an unknown command errors instead of counting as a bare invocation", async () => {
  await assert.rejects(run(["project", "list"]), /No command project/);
});
