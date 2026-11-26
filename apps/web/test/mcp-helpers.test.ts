import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerSnapshotPayload } from "@eevee/protocol";
import {
  buildRoleTogglePatch,
  mergeProjectOverridePatch,
} from "../src/components/settings/mcp-helpers.ts";

function makeServer(overrides: Partial<McpServerSnapshotPayload> = {}): McpServerSnapshotPayload {
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

test("buildRoleTogglePatch only writes the toggled role for project overrides", () => {
  const srv = makeServer({ scope: "global", roles: { router: true, worker: true } });

  const workerPatch = buildRoleTogglePatch(srv, "worker", false, true);
  assert.deepEqual(workerPatch, { roles: { worker: false } });
  assert.equal("router" in workerPatch.roles, false);

  const merged = mergeProjectOverridePatch(undefined, workerPatch);
  assert.deepEqual(merged, { roles: { worker: false } });

  const secondMerged = mergeProjectOverridePatch(
    merged,
    buildRoleTogglePatch(
      makeServer({ scope: "override", roles: { router: true, worker: false } }),
      "router",
      false,
      true,
    ),
  );
  assert.deepEqual(secondMerged, { roles: { worker: false, router: false } });
});

test("buildRoleTogglePatch preserves both roles for global and project-only servers", () => {
  const globalSrv = makeServer({ scope: "global", roles: { router: true, worker: false } });
  assert.deepEqual(buildRoleTogglePatch(globalSrv, "router", false, false), {
    roles: { router: false, worker: false },
  });

  const projectOnlySrv = makeServer({ scope: "project", roles: { router: false, worker: true } });
  assert.deepEqual(buildRoleTogglePatch(projectOnlySrv, "worker", false, false), {
    roles: { router: false, worker: false },
  });
});
