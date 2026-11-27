import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createTestEnvironment } from "./test.ts";

const home = "/isolated/home";

test("createTestEnvironment redirects home and temp variables to the isolated home", () => {
  const env = createTestEnvironment({}, home);
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.TMPDIR, join(home, "tmp"));
  assert.equal(env.TEMP, join(home, "tmp"));
  assert.equal(env.XDG_CONFIG_HOME, join(home, ".config"));
});

test("createTestEnvironment strips EEVEE_HOME, credentials, and proxy variables", () => {
  const env = createTestEnvironment(
    {
      EEVEE_HOME: "/real/.eevee",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      AWS_ACCESS_KEY_ID: "AKIA...",
      HTTP_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      PATH: "/usr/bin",
    },
    home,
  );
  assert.equal(env.EEVEE_HOME, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("createTestEnvironment preserves unrelated variables", () => {
  const env = createTestEnvironment({ PATH: "/usr/bin", SYSTEMROOT: "C:\\Windows" }, home);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
});
