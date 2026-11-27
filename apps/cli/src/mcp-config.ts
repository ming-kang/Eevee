import {
  isMcpHttpConfig,
  isMcpStdioConfig,
  McpExposureInputSchema,
  normalizeMcpExposure,
  parseWithSchema,
} from "@eevee/protocol";
import { isRecord, parseKeyValueFlags, parsePositiveIntFlag } from "./args.ts";

export type McpAddOptions = {
  project?: string;
  command?: string;
  args?: string[];
  url?: string;
  exposure?: string;
  description?: string;
  cwd?: string;
  env?: string[];
  header?: string[];
  timeout?: string;
  disabled?: boolean;
  router?: boolean;
  worker?: boolean;
  replace?: boolean;
  json?: boolean;
};

export function mergeMcpAddConfig(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  options: { readonly isPartialOverride: boolean; readonly switchTransport: boolean },
): Record<string, unknown> {
  if (existing === undefined) {
    const created: Record<string, unknown> = { ...incoming };
    if (!options.isPartialOverride && isRecord(incoming.roles)) {
      created.roles = {
        router: incoming.roles.router ?? true,
        worker: incoming.roles.worker ?? true,
      };
    }
    return created;
  }
  const base: Record<string, unknown> = { ...existing };
  if (options.switchTransport) {
    const drop =
      incoming.command !== undefined
        ? ["url", "headers", "oauth", "type"]
        : ["command", "args", "cwd", "env", "type"];
    for (const key of drop) delete base[key];
  }
  const merged: Record<string, unknown> = { ...base, ...incoming };
  for (const key of ["env", "headers", "roles"] as const) {
    if (isRecord(incoming[key])) {
      merged[key] = isRecord(base[key]) ? { ...base[key], ...incoming[key] } : { ...incoming[key] };
    }
  }
  return merged;
}

export function parseMcpAddIncoming(options: McpAddOptions, projectId: string | undefined) {
  if (options.command !== undefined && options.url !== undefined) {
    throw new Error(
      projectId === undefined
        ? "Specify exactly one of --command or --url"
        : "Cannot combine --command and --url",
    );
  }
  if (projectId === undefined && options.command === undefined && options.url === undefined) {
    throw new Error("Specify exactly one of --command or --url");
  }
  const isPartialOverride =
    projectId !== undefined && options.command === undefined && options.url === undefined;
  const incoming: Record<string, unknown> = {};
  for (const key of ["command", "url", "args", "cwd", "description"] as const) {
    if (options[key] !== undefined) incoming[key] = options[key];
  }
  const envVars = parseKeyValueFlags(options.env, "--env");
  const headers = parseKeyValueFlags(options.header, "--header");
  if (envVars) incoming.env = envVars;
  if (headers) incoming.headers = headers;
  if (options.exposure !== undefined) {
    incoming.exposure = normalizeMcpExposure(
      parseWithSchema(McpExposureInputSchema, options.exposure, "--exposure"),
    );
  }
  if (options.timeout !== undefined) {
    incoming.timeout = parsePositiveIntFlag(options.timeout, "--timeout");
  }
  if (options.disabled !== undefined) incoming.enabled = !options.disabled;
  if (options.router !== undefined || options.worker !== undefined) {
    incoming.roles = {
      ...(options.router === undefined ? {} : { router: options.router }),
      ...(options.worker === undefined ? {} : { worker: options.worker }),
    };
  }
  if (isPartialOverride && Object.keys(incoming).length === 0) {
    throw new Error(
      "Specify --command, --url, or at least one override flag (--exposure, --description, --timeout, --disabled, --router/--no-router, --worker/--no-worker)",
    );
  }
  return { incoming, isPartialOverride };
}

export function shouldSwitchMcpTransport(
  existing: Record<string, unknown> | undefined,
  options: McpAddOptions,
): boolean {
  return (
    (options.command !== undefined && isMcpHttpConfig(existing)) ||
    (options.url !== undefined && isMcpStdioConfig(existing))
  );
}
