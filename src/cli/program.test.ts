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

test("不带命令时先启动 Engine，再打开面板", async () => {
  assert.deepEqual(await run([]), ["start", "web"]);
});

test("每个命令只做自己的事", async () => {
  assert.deepEqual(await run(["start"]), ["start"]);
  assert.deepEqual(await run(["stop"]), ["stop"]);
  assert.deepEqual(await run(["status"]), ["status"]);
  assert.deepEqual(await run(["web"]), ["web"]);
});

test("不认识的命令报错，不会当成不带命令", async () => {
  await assert.rejects(run(["project", "list"]), /没有命令 project/);
});
