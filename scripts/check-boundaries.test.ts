import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkSource, checkWorkspaceManifest, extractGitInvocations } from "./check-boundaries.ts";

const ws = (name: string) => join("/repo/packages", name);

test("workspace manifest DAG enforces unidirectional boundaries", () => {
  assert.deepEqual(
    checkWorkspaceManifest({
      workspaceName: "@eevee/core",
      dependencies: { "@eevee/agent": "0.0.1", "@eevee/memory": "0.0.1" },
    }),
    [],
  );
  assert.match(
    checkWorkspaceManifest({
      workspaceName: "@eevee/core",
      dependencies: { "@eevee/engine": "0.0.1" },
    })[0] ?? "",
    /forbidden workspace dependency -> @eevee\/engine/,
  );
  assert.match(
    checkWorkspaceManifest({
      workspaceName: "@eevee/agent",
      dependencies: { "@eevee/memory": "0.0.1" },
    })[0] ?? "",
    /forbidden workspace dependency -> @eevee\/memory/,
  );
});

test("source boundary checker catches layer, runtime, extension, and relative import violations", () => {
  const coreDir = ws("core");
  assert.deepEqual(
    checkSource({
      workspaceName: "@eevee/core",
      workspaceDir: coreDir,
      file: join(coreDir, "src/index.ts"),
      sourceText: 'import { AGENT_EXTENSIONS } from "@eevee/agent";',
      declaredDeps: new Set(["@eevee/agent", "@eevee/memory"]),
    }),
    [],
  );

  assert.match(
    checkSource({
      workspaceName: "@eevee/core",
      workspaceDir: coreDir,
      file: join(coreDir, "src/index.ts"),
      sourceText: 'import { DatabaseSync } from "node:sqlite";',
      declaredDeps: new Set(["@eevee/agent", "@eevee/memory"]),
    })[0] ?? "",
    /storage\/transport-agnostic/,
  );

  const protocolDir = ws("protocol");
  assert.match(
    checkSource({
      workspaceName: "@eevee/protocol",
      workspaceDir: protocolDir,
      file: join(protocolDir, "src/index.ts"),
      sourceText: 'import { readFileSync } from "node:fs";',
      declaredDeps: new Set(),
    })[0] ?? "",
    /runtime-neutral/,
  );

  const agentDir = ws("agent");
  assert.match(
    checkSource({
      workspaceName: "@eevee/agent",
      workspaceDir: agentDir,
      file: join(agentDir, "src/extensions/tasks/index.ts"),
      sourceText: 'import { x } from "../mcp/index.ts";',
      declaredDeps: new Set(),
    })[0] ?? "",
    /must not import sibling extension/,
  );

  assert.match(
    checkSource({
      workspaceName: "@eevee/agent",
      workspaceDir: agentDir,
      file: join(agentDir, "src/index.ts"),
      sourceText: 'import { x } from "./models/index.js";',
      declaredDeps: new Set(),
    })[0] ?? "",
    /relative \.js import/,
  );

  assert.match(
    checkSource({
      workspaceName: "@eevee/engine",
      workspaceDir: ws("engine"),
      file: join(ws("engine"), "src/index.ts"),
      sourceText: 'import { Host } from "@earendil-works/chord";',
      declaredDeps: new Set(),
    })[0] ?? "",
    /root host runtime is forbidden/,
  );
});

test("git invocation detection covers direct, aliased, and namespace child_process calls", () => {
  for (const source of [
    'import { spawn as launch } from "node:child_process"; launch("git", []);',
    'import * as cp from "node:child_process"; cp.exec("git status");',
    'import { execFileSync } from "child_process"; execFileSync("git.exe", []);',
  ]) {
    assert.equal(extractGitInvocations(source).length, 1, source);
  }
  assert.deepEqual(
    extractGitInvocations('import { spawn } from "node:child_process"; spawn("node", []);'),
    [],
  );
});
