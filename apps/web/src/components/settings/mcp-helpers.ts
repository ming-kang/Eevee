import type { McpServerSnapshotPayload } from "@eevee/protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildRoleTogglePatch(
  srv: McpServerSnapshotPayload,
  role: "router" | "worker",
  checked: boolean,
  isProjectOverride: boolean,
): { readonly roles: { readonly router?: boolean; readonly worker?: boolean } } {
  if (isProjectOverride) {
    return { roles: { [role]: checked } };
  }
  const currentRouter = srv.roles?.router !== false;
  const currentWorker = srv.roles?.worker !== false;
  return {
    roles: {
      router: role === "router" ? checked : currentRouter,
      worker: role === "worker" ? checked : currentWorker,
    },
  };
}

export function mergeProjectOverridePatch(
  existingOverride: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = existingOverride ?? {};
  const merged: Record<string, unknown> = { ...base, ...patch };
  if (isRecord(base.roles) && isRecord(patch.roles)) {
    merged.roles = { ...base.roles, ...patch.roles };
  }
  return merged;
}
