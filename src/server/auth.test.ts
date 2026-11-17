import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Auth, CODE_TTL_MS, isLoopbackRequest, SESSION_IDLE_MS } from "./auth.ts";

let dir: string;
let now = 0;
const open = () =>
  Auth.open({
    cliTokenPath: join(dir, "cli-token"),
    sessionsPath: join(dir, "sessions.json"),
    now: () => now,
  });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-auth-"));
});
after(() => rm(dir, { recursive: true, force: true }));

test("授权码只能用一次，过期作废", async () => {
  const auth = await open();
  const code = auth.issueCode();
  const session = await auth.exchange(code);
  assert.ok(session);
  assert.equal(await auth.exchange(code), undefined);

  const late = auth.issueCode();
  now += CODE_TTL_MS + 1;
  assert.equal(await auth.exchange(late), undefined);
});

test("会话 12 小时无操作过期，使用会续期；重启后仍然有效", async () => {
  const auth = await open();
  const session = (await auth.exchange(auth.issueCode())) ?? "";
  now += SESSION_IDLE_MS - 1000;
  assert.equal(auth.verify(session), "browser");
  assert.equal((await open()).verify(session), "browser");
  now += SESSION_IDLE_MS + 1;
  assert.equal(auth.verify(session), undefined);
});

test("错误的 token 不被接受", async () => {
  const auth = await open();
  assert.equal(auth.verify("nope"), undefined);
  assert.equal(auth.verify(undefined), undefined);
});

test("只接受回环地址的 Host 与 Origin", () => {
  const req = (headers: Record<string, string>) => ({ headers });
  assert.equal(isLoopbackRequest(req({ host: "127.0.0.1:19190" })), true);
  assert.equal(
    isLoopbackRequest(req({ host: "[::1]:19190", origin: "http://localhost:19190" })),
    true,
  );
  assert.equal(isLoopbackRequest(req({ host: "evil.example:19190" })), false);
  assert.equal(
    isLoopbackRequest(req({ host: "127.0.0.1:19190", origin: "https://evil.example" })),
    false,
  );
});
