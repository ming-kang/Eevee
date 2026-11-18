import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Auth, CODE_TTL_MS, isLoopbackRequest } from "./auth.ts";

let dir: string;
let now = 0;
const tokenPath = () => join(dir, "token");
const open = () => Auth.open({ tokenPath: tokenPath(), now: () => now });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-auth-"));
});
after(() => rm(dir, { recursive: true, force: true }));

test("授权码换到的就是 token 文件里的 token，重启后不变", async () => {
  const auth = await open();
  const token = (await readFile(tokenPath(), "utf8")).trim();
  assert.equal(auth.exchange(auth.issueCode()), token);
  assert.equal(auth.verify(token), true);
  assert.equal((await open()).verify(token), true);
});

test("授权码只能用一次，过期作废", async () => {
  const auth = await open();
  const code = auth.issueCode();
  assert.ok(auth.exchange(code));
  assert.equal(auth.exchange(code), undefined);

  const late = auth.issueCode();
  now += CODE_TTL_MS + 1;
  assert.equal(auth.exchange(late), undefined);
});

test("错误的 token 和授权码本身都不被接受", async () => {
  const auth = await open();
  assert.equal(auth.verify("nope"), false);
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify(auth.issueCode()), false);
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
