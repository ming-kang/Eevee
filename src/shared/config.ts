import { compile, type Schema, type Static } from "@earendil-works/pi-schema";
import { readJson } from "./fs.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Validates a parsed config value; the error names the file and every failing path. */
export function parseConfig<S extends Schema>(schema: S, value: unknown, file: string): Static<S> {
  const result = compile(schema).validate(value);
  if (result.ok) return result.value as Static<S>;
  const problems = result.errors.map((e) => `  ${e.path || "/"}：${e.message}`).join("\n");
  throw new ConfigError(`${file} 格式不对：\n${problems}`);
}

/** Reads and validates a JSON config file; a missing file reads as `fallback`. */
export async function loadConfig<S extends Schema>(
  schema: S,
  path: string,
  fallback: Static<S>,
): Promise<Static<S>> {
  const value = await readJson<unknown>(path);
  return value === undefined ? fallback : parseConfig(schema, value, path);
}

/**
 * Resolves a config value that may reference environment variables, as `$NAME` or `${NAME}`.
 * Undefined when a referenced variable is not set.
 */
export async function resolveConfigValue(
  raw: string,
  env: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const names = [...raw.matchAll(ENV_REFERENCE)].map((m) => m[1] ?? m[2] ?? "");
  const values = new Map<string, string>();
  for (const name of names) {
    const value = await env(name);
    if (value === undefined) return undefined;
    values.set(name, value);
  }
  return raw.replace(ENV_REFERENCE, (_, a?: string, b?: string) => values.get(a ?? b ?? "") ?? "");
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export const processEnv = async (name: string): Promise<string | undefined> => process.env[name];
