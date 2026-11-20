import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMcpDraft, isServerName, parsePastedServer, toMcpDraft } from "./mcp-draft.ts";

test("a stdio entry round-trips: one arg per line, defaults left out, extra fields kept", () => {
  const original = {
    command: "npx",
    args: ["-y", "server-filesystem", "/home/me/My Papers"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp.json references variables as ${NAME}
    env: { TOKEN: "${TOKEN}" },
    exposure: "direct",
    custom: { kept: true },
  };
  const draft = toMcpDraft(original);
  assert.equal(draft.transport, "stdio");
  assert.equal(draft.args, "-y\nserver-filesystem\n/home/me/My Papers");
  assert.deepEqual(fromMcpDraft(draft, original), { config: original });

  draft.exposure = "deferred";
  draft.enabled = false;
  draft.timeout = "30";
  draft.args = "-y\n\n server-filesystem\n";
  assert.deepEqual(fromMcpDraft(draft, original), {
    config: {
      command: "npx",
      args: ["-y", " server-filesystem"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp.json references variables as ${NAME}
      env: { TOKEN: "${TOKEN}" },
      custom: { kept: true },
      enabled: false,
      timeout: 30,
    },
  });
});

test("switching to HTTP drops the stdio fields and keeps an HTTP entry's oauth", () => {
  const draft = toMcpDraft({ command: "x", args: ["a"], cwd: "/tmp" });
  draft.transport = "http";
  draft.url = "https://docs.example/mcp";
  draft.headers = [{ key: "Authorization", value: "Bearer $T" }];
  assert.deepEqual(fromMcpDraft(draft, { command: "x", args: ["a"], cwd: "/tmp" }), {
    config: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer $T" } },
  });

  const http = { type: "http", url: "https://a.example/mcp", oauth: { clientId: "c" } };
  assert.equal(toMcpDraft(http).transport, "http");
  assert.deepEqual(fromMcpDraft(toMcpDraft(http), http), { config: http });
});

test("a missing command, missing URL or non-positive timeout names which one", () => {
  assert.deepEqual(fromMcpDraft(toMcpDraft(undefined), undefined), {
    error: { code: "required", field: "command" },
  });
  const draft = toMcpDraft({ url: "" });
  draft.transport = "http";
  assert.deepEqual(fromMcpDraft(draft, undefined), { error: { code: "required", field: "url" } });
  draft.url = "https://a.example/mcp";
  draft.timeout = "0";
  assert.deepEqual(fromMcpDraft(draft, undefined), { error: { code: "timeout" } });
});

test("pasting another client's config: a whole file, a named entry or a bare entry all parse", () => {
  assert.deepEqual(
    parsePastedServer(
      '{ "mcpServers": { "github": { "command": "gh-mcp" }, "b": { "url": "u" } } }',
    ),
    { name: "github", config: { command: "gh-mcp" } },
  );
  assert.deepEqual(parsePastedServer('"docs": { "url": "https://d.example/mcp" },'), {
    name: "docs",
    config: { url: "https://d.example/mcp" },
  });
  assert.deepEqual(parsePastedServer('{ "command": "x" }'), { config: { command: "x" } });
  assert.equal(parsePastedServer("not json"), undefined);
  assert.equal(parsePastedServer('{ "a": 1 }'), undefined);
});

test("a server name may only have letters, digits, _ and -", () => {
  assert.ok(isServerName("git_hub-2"));
  assert.ok(!isServerName("git hub"));
  assert.ok(!isServerName("a.b"));
});
