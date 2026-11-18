import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubbedEnv } from "./env.ts";

test("the child environment keeps only allow-listed variables and never passes credentials", () => {
  const env = scrubbedEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp-secret",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/me" });
});
