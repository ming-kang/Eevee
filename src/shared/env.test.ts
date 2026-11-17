import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubbedEnv } from "./env.ts";

test("执行环境只保留白名单变量，凭据不会传给子进程", () => {
  const env = scrubbedEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp-secret",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/me" });
});
