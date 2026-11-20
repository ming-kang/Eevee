import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth, CODE_TTL_MS, isLoopbackRequest } from "./auth.ts";

let now = 0;
const open = () => new Auth({ now: () => now });

test("codes exchange for the runtime token; callers can supply it explicitly", async () => {
  const auth = await open();
  const token = auth.token;
  assert.equal(auth.exchange(auth.issueCode()), token);
  assert.equal(auth.verify(token), true);
  assert.equal(new Auth({ token }).verify(token), true);
  assert.notEqual(open().token, token);
});

test("a code works once and expires when stale", async () => {
  const auth = await open();
  const code = auth.issueCode();
  assert.ok(auth.exchange(code));
  assert.equal(auth.exchange(code), undefined);

  const late = auth.issueCode();
  now += CODE_TTL_MS + 1;
  assert.equal(auth.exchange(late), undefined);
});

test("a wrong token and a code itself are both rejected", async () => {
  const auth = await open();
  assert.equal(auth.verify("nope"), false);
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify(auth.issueCode()), false);
});

test("only loopback Host and Origin are accepted", () => {
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
