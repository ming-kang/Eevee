import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServerSnapshotPayload } from "@eevee/protocol";
import {
  buildConfigFromForm,
  connectionFieldsMatch,
  createBlankForm,
  formFromConfig,
  normalizeExposure,
  normalizeServerMap,
  parseImportJson,
  scopeBadge,
  statusMeta,
  targetSummary,
  validateServerName,
} from "../src/components/settings/mcp/codec.ts";
import {
  buildPatchedServerConfig,
  buildScopedServerPayload,
  normalizeMcpState,
  resolveToolExposureUpdate,
} from "../src/components/settings/mcp/scope-helpers.ts";

function makeSnapshot(overrides: Partial<McpServerSnapshotPayload> = {}): McpServerSnapshotPayload {
  return {
    name: "docs",
    status: "connected",
    enabled: true,
    toolCount: 2,
    transport: "stdio",
    roles: { router: true, worker: true },
    exposure: "codemode",
    hasResources: false,
    scope: "global",
    ...overrides,
  };
}

test("formFromConfig populates stdio, http/oauth, legacy exposure, and snapshot fallbacks", () => {
  const stdioForm = formFromConfig(
    "fs",
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      cwd: "/repo",
      env: { API_KEY: "$FS_KEY" },
      enabled: false,
      description: "File server",
      timeout: 15,
      exposure: "codemode-deferred",
      roles: { router: true, worker: false },
    },
    undefined,
  );
  assert.equal(stdioForm.mode, "edit");
  assert.equal(stdioForm.originalName, "fs");
  assert.equal(stdioForm.transport, "stdio");
  assert.equal(stdioForm.enabled, false);
  assert.equal(stdioForm.description, "File server");
  assert.equal(stdioForm.command, "npx");
  assert.equal(stdioForm.argsText, "-y\n@modelcontextprotocol/server-filesystem\n.");
  assert.equal(stdioForm.cwd, "/repo");
  assert.deepEqual(
    stdioForm.envRows.map((r) => ({ key: r.key, value: r.value })),
    [{ key: "API_KEY", value: "$FS_KEY" }],
  );
  assert.equal(stdioForm.timeoutText, "15");
  assert.equal(stdioForm.exposure, "codemode");
  assert.equal(stdioForm.roleRouter, true);
  assert.equal(stdioForm.roleWorker, false);

  const httpForm = formFromConfig(
    "linear",
    {
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer $TOKEN" },
      exposure: "direct",
      oauth: {
        clientId: "cid",
        clientSecret: "csec",
        scope: "read write",
        callbackPort: 8787,
        callbackUrl: "http://127.0.0.1:8787/cb",
        clientName: "Eevee",
        clientRegistration: "cimd",
        authServerMetadataUrl: "https://auth.example.com/.well-known",
      },
    },
    undefined,
  );
  assert.equal(httpForm.transport, "http");
  assert.equal(httpForm.url, "https://mcp.linear.app/mcp");
  assert.deepEqual(
    httpForm.headerRows.map((r) => ({ key: r.key, value: r.value })),
    [{ key: "Authorization", value: "Bearer $TOKEN" }],
  );
  assert.equal(httpForm.exposure, "direct");
  assert.equal(httpForm.oauthAdvancedOpen, true);
  assert.equal(httpForm.oauthClientId, "cid");
  assert.equal(httpForm.oauthCallbackPort, "8787");
  assert.equal(httpForm.oauthClientRegistration, "cimd");

  const fallbackForm = formFromConfig(
    "remote",
    { oauth: { clientRegistration: "invalid" } },
    makeSnapshot({
      transport: "http",
      enabled: false,
      description: "From snapshot",
      exposure: "hidden",
      roles: { router: false, worker: true },
    }),
  );
  assert.equal(fallbackForm.transport, "http");
  assert.equal(fallbackForm.enabled, false);
  assert.equal(fallbackForm.description, "From snapshot");
  assert.equal(fallbackForm.exposure, "hidden");
  assert.equal(fallbackForm.roleRouter, false);
  assert.equal(fallbackForm.roleWorker, true);
  assert.equal(fallbackForm.oauthClientRegistration, "");
});

test("buildConfigFromForm builds valid stdio and http configs and preserves toolExposure", () => {
  const stdioConfig = buildConfigFromForm(
    {
      ...createBlankForm(),
      name: "git",
      transport: "stdio",
      enabled: true,
      description: " Git tools ",
      command: " uvx ",
      argsText: " mcp-server-git \n\n --repository \r\n . ",
      cwd: " /workspace ",
      envRows: [{ uid: 1, key: "LOG_LEVEL", value: "info" }],
      timeoutText: "30",
      exposure: "deferred",
      roleRouter: false,
      roleWorker: true,
    },
    { toolExposure: { git_status: "direct", legacy: "codemode-deferred" } },
  );
  assert.deepEqual(stdioConfig, {
    enabled: true,
    description: "Git tools",
    timeout: 30,
    exposure: "deferred",
    roles: { router: false, worker: true },
    toolExposure: { git_status: "direct", legacy: "codemode" },
    command: "uvx",
    args: ["mcp-server-git", "--repository", "."],
    cwd: "/workspace",
    env: { LOG_LEVEL: "info" },
  });

  const httpConfig = buildConfigFromForm(
    {
      ...createBlankForm(),
      name: "notion",
      transport: "http",
      url: "https://mcp.notion.so/mcp",
      headerRows: [{ uid: 2, key: "X-Custom", value: "val" }],
      oauthClientId: "notion-client",
      oauthCallbackPort: "9000",
      oauthClientRegistration: "dcr",
    },
    undefined,
  );
  assert.deepEqual(httpConfig, {
    enabled: true,
    exposure: "codemode",
    roles: { router: true, worker: true },
    url: "https://mcp.notion.so/mcp",
    headers: { "X-Custom": "val" },
    oauth: {
      clientId: "notion-client",
      callbackPort: 9000,
      clientRegistration: "dcr",
    },
  });
});

test("buildConfigFromForm and validateServerName enforce validation error paths", () => {
  assert.throws(() => validateServerName("   "), /请填写服务名称/);
  assert.throws(() => validateServerName("bad name!"), /只能包含字母、数字/);
  assert.equal(validateServerName(" my-mcp_1 "), "my-mcp_1");

  assert.throws(
    () => buildConfigFromForm({ ...createBlankForm(), timeoutText: "0" }, undefined),
    /大于 0 的数字/,
  );
  assert.throws(
    () => buildConfigFromForm({ ...createBlankForm(), timeoutText: "abc" }, undefined),
    /大于 0 的数字/,
  );
  assert.throws(
    () => buildConfigFromForm({ ...createBlankForm(), command: "   " }, undefined),
    /stdio 启动命令/,
  );
  assert.throws(
    () =>
      buildConfigFromForm(
        {
          ...createBlankForm(),
          command: "npx",
          envRows: [{ uid: 1, key: "", value: "123" }],
        },
        undefined,
      ),
    /环境变量第 1 行缺少 Header 名称/,
  );
  assert.throws(
    () => buildConfigFromForm({ ...createBlankForm(), transport: "http", url: "" }, undefined),
    /请填写 HTTP 服务 URL/,
  );
  assert.throws(
    () =>
      buildConfigFromForm({ ...createBlankForm(), transport: "http", url: "not-a-url" }, undefined),
    /URL 格式无效/,
  );
  assert.throws(
    () =>
      buildConfigFromForm(
        { ...createBlankForm(), transport: "http", url: "ftp://example.com/mcp" },
        undefined,
      ),
    /必须以 http:\/\/ 或 https:\/\/ 开头/,
  );
  assert.throws(
    () =>
      buildConfigFromForm(
        {
          ...createBlankForm(),
          transport: "http",
          url: "https://example.com/mcp",
          oauthCallbackPort: "70000",
        },
        undefined,
      ),
    /1~65535/,
  );
  assert.throws(
    () =>
      buildConfigFromForm(
        {
          ...createBlankForm(),
          transport: "http",
          url: "https://example.com/mcp",
          oauthCallbackPort: "12.5",
        },
        undefined,
      ),
    /1~65535/,
  );
});

test("parseImportJson accepts wrapped and direct maps and rejects malformed JSON/shapes", () => {
  assert.deepEqual(
    parseImportJson('{"mcpServers":{"github":{"command":"npx","args":["-y","gh"]}}}'),
    { github: { command: "npx", args: ["-y", "gh"] } },
  );
  assert.deepEqual(parseImportJson('{"linear":{"url":"https://mcp.linear.app/mcp"}}'), {
    linear: { url: "https://mcp.linear.app/mcp" },
  });

  assert.throws(() => parseImportJson("{bad json"), /JSON 解析失败/);
  assert.throws(() => parseImportJson("[]"), /JSON 根节点必须是对象/);
  assert.throws(() => parseImportJson('{"mcpServers":[]}'), /mcpServers 字段必须是对象/);
  assert.throws(() => parseImportJson('{"mcpServers":{"gh":"bad"}}'), /配置必须是 JSON 对象/);
});

test("connectionFieldsMatch compares transport and connection fields while ignoring toggles", () => {
  const globalEntry = {
    command: "npx",
    args: ["-y", "server"],
    env: { A: "1", B: "2" },
    enabled: true,
    exposure: "codemode",
    roles: { router: true, worker: true },
  };
  const candidateSame = {
    command: "npx",
    args: ["-y", "server"],
    env: { B: "2", A: "1" },
    cwd: undefined,
    enabled: false,
    exposure: "hidden",
    roles: { router: false, worker: false },
  };
  assert.equal(connectionFieldsMatch(candidateSame, globalEntry), true);

  assert.equal(
    connectionFieldsMatch({ ...candidateSame, args: ["server", "-y"] }, globalEntry),
    false,
  );
  assert.equal(connectionFieldsMatch({ url: "https://example.com/mcp" }, globalEntry), false);
  assert.equal(
    connectionFieldsMatch(
      { url: "https://example.com/mcp", timeout: 10 },
      { url: "https://example.com/mcp", timeout: 20 },
    ),
    false,
  );
});

test("scoped payload, override patching, tool exposure updates, and state normalization", () => {
  const globalServers = {
    gh: {
      command: "npx",
      args: ["-y", "gh"],
      enabled: true,
      exposure: "codemode",
      roles: { router: true, worker: true },
    },
  };
  const editOverrideForm = {
    ...formFromConfig("gh", globalServers.gh, makeSnapshot({ name: "gh" })),
    enabled: false,
    exposure: "hidden" as const,
  };
  assert.deepEqual(
    buildScopedServerPayload({
      isProject: true,
      serverName: "gh",
      form: editOverrideForm,
      globalServers,
      projectServers: { gh: { toolExposure: { search: "direct" } } },
      effectiveServers: globalServers,
    }),
    {
      enabled: false,
      exposure: "hidden",
      roles: { router: true, worker: true },
      toolExposure: { search: "direct" },
    },
  );

  const editFullForm = { ...editOverrideForm, command: "gh-mcp" };
  const fullPayload = buildScopedServerPayload({
    isProject: true,
    serverName: "gh",
    form: editFullForm,
    globalServers,
    projectServers: {},
    effectiveServers: globalServers,
  });
  assert.equal(fullPayload.command, "gh-mcp");

  const globalSnap = makeSnapshot({ name: "gh", scope: "global" });
  assert.deepEqual(
    buildPatchedServerConfig({
      isProject: true,
      server: globalSnap,
      globalServers,
      projectServers: { gh: { roles: { worker: false } } },
      effectiveServers: globalServers,
      patch: { roles: { router: false } },
    }),
    { roles: { worker: false, router: false } },
  );

  assert.deepEqual(
    resolveToolExposureUpdate({
      isProject: true,
      server: globalSnap,
      globalServers,
      projectServers: { gh: { toolExposure: { search: "direct" } } },
      toolName: "search",
      nextValue: "",
    }),
    { action: "delete" },
  );

  const globalNormalized = normalizeMcpState({
    servers: { a: { command: "echo" } },
    status: [globalSnap],
  });
  assert.deepEqual(globalNormalized.globalServers, { a: { command: "echo" } });
  assert.deepEqual(globalNormalized.projectServers, {});
  assert.deepEqual(globalNormalized.effectiveServers, { a: { command: "echo" } });

  assert.deepEqual(normalizeServerMap({ a: { command: "echo" }, bad: "ignore" }), {
    a: { command: "echo" },
  });

  const projectNormalized = normalizeMcpState({
    globalServers: { a: { command: "echo" } },
    projectServers: { a: { enabled: false } },
    effectiveServers: { a: { command: "echo", enabled: false } },
    status: [globalSnap],
  });
  assert.deepEqual(projectNormalized.projectServers, { a: { enabled: false } });
  assert.deepEqual(projectNormalized.effectiveServers, { a: { command: "echo", enabled: false } });

  assert.equal(normalizeExposure("unknown"), "codemode");
  assert.equal(statusMeta("auth_required").tone, "warning");
  assert.equal(scopeBadge("override")?.label, "项目覆盖");
  assert.equal(targetSummary({ command: "npx", args: ["-y", "gh"] }), "npx -y gh");
  assert.deepEqual(normalizeServerMap(undefined), {});
});
