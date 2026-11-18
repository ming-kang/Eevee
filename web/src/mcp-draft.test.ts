import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMcpDraft, isServerName, parsePastedServer, toMcpDraft } from "./mcp-draft.ts";

test("stdio 条目往返：参数一行一个，默认值不写进文件，表单外的字段保留", () => {
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

test("换成 HTTP 时去掉 stdio 的字段，HTTP 条目的 oauth 保留", () => {
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

test("缺命令、缺地址或超时不是正数时指明是哪一项", () => {
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

test("粘贴别的客户端的配置：整份文件、一个具名条目或一个裸条目都认", () => {
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

test("服务器名只能有字母、数字、_ 和 -", () => {
  assert.ok(isServerName("git_hub-2"));
  assert.ok(!isServerName("git hub"));
  assert.ok(!isServerName("a.b"));
});
