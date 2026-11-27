import { execSync } from "node:child_process";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

const commandCache = new Map<string, string | undefined>();

export type ResolveConfigValueOptions = {
  readonly cacheCommands?: boolean;
};

export type ConfigValueFailure = {
  readonly key: string;
  readonly raw: string;
  readonly isCommand: boolean;
  readonly missingEnvVars: readonly string[];
};

export type ResolveConfigRecordStrictOptions = ResolveConfigValueOptions & {
  readonly label?: string;
  readonly formatError?: (failure: ConfigValueFailure) => Error;
};

type TemplatePart =
  | { readonly type: "literal"; value: string }
  | { readonly type: "env"; readonly name: string };
type ConfigRef =
  | { readonly type: "command"; readonly command: string }
  | { readonly type: "template"; readonly parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const last = parts.at(-1);
  if (last?.type === "literal") {
    last.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

function parseTemplate(raw: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;

  while (index < raw.length) {
    const dollar = raw.indexOf("$", index);
    if (dollar < 0) {
      appendLiteral(parts, raw.slice(index));
      break;
    }

    appendLiteral(parts, raw.slice(index, dollar));
    const next = raw[dollar + 1];

    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollar + 2;
      continue;
    }

    if (next === "{") {
      const close = raw.indexOf("}", dollar + 2);
      if (close < 0) {
        appendLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const name = raw.slice(dollar + 2, close);
      if (ENV_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(parts, raw.slice(dollar, close + 1));
      }
      index = close + 1;
      continue;
    }

    const match = ENV_NAME_PREFIX_RE.exec(raw.slice(dollar + 1));
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }

    appendLiteral(parts, "$");
    index = dollar + 1;
  }

  return parts;
}

function parseRef(raw: string): ConfigRef {
  if (raw.startsWith("!")) {
    return { type: "command", command: raw.slice(1) };
  }
  return { type: "template", parts: parseTemplate(raw) };
}

function readEnv(
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const explicit = env?.[name];
  if (explicit !== undefined && explicit !== "") return explicit;
  const ambient = process.env[name];
  return ambient === undefined || ambient === "" ? undefined : ambient;
}

function runCommand(command: string, cache: boolean): string | undefined {
  if (cache && commandCache.has(command)) return commandCache.get(command);
  let output: string | undefined;
  try {
    const raw = execSync(command, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const trimmed = raw.trim();
    output = trimmed.length > 0 ? trimmed : undefined;
  } catch {
    output = undefined;
  }
  if (cache) commandCache.set(command, output);
  return output;
}

export function invalidateConfigValueCache(command?: string): void {
  if (command === undefined) {
    commandCache.clear();
  } else {
    commandCache.delete(command);
    if (command.startsWith("!")) commandCache.delete(command.slice(1));
  }
}

export function clearConfigValueCache(): void {
  invalidateConfigValueCache();
}

export function isCommandConfigValue(raw: string): boolean {
  return raw.startsWith("!");
}

export function getConfigValueEnvVarNames(raw: string): string[] {
  const ref = parseRef(raw);
  if (ref.type !== "template") return [];
  const names: string[] = [];
  for (const part of ref.parts) {
    if (part.type === "env" && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

export function isConfigValueConfigured(
  raw: string,
  env?: Readonly<Record<string, string | undefined>>,
): boolean {
  const ref = parseRef(raw);
  if (ref.type === "command") return ref.command.trim().length > 0;
  return ref.parts.every(
    (part) => part.type === "literal" || readEnv(part.name, env) !== undefined,
  );
}

export function resolveConfigValue(
  raw: string,
  env?: Readonly<Record<string, string | undefined>>,
  options?: ResolveConfigValueOptions,
): string | undefined {
  const ref = parseRef(raw);
  if (ref.type === "command") return runCommand(ref.command, options?.cacheCommands ?? true);
  let resolved = "";
  for (const part of ref.parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const value = readEnv(part.name, env);
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

export function resolveHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  env?: Readonly<Record<string, string | undefined>>,
  options?: ResolveConfigValueOptions,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    const value = resolveConfigValue(raw, env, options);
    if (value !== undefined) resolved[key] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveConfigRecordStrict(
  record: Readonly<Record<string, string>> | undefined,
  env?: Readonly<Record<string, string | undefined>>,
  options?: ResolveConfigRecordStrictOptions,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const value = resolveConfigValue(raw, env, options);
    if (value === undefined) {
      const missingEnvVars = getConfigValueEnvVarNames(raw).filter(
        (name) => readEnv(name, env) === undefined,
      );
      const isCommand = isCommandConfigValue(raw);
      if (options?.formatError) {
        throw options.formatError({ key, raw, isCommand, missingEnvVars });
      }
      const label = options?.label ?? "config value";
      const reason = isCommand
        ? "its !command failed or returned an empty value"
        : missingEnvVars.length > 0
          ? `missing environment variable${missingEnvVars.length === 1 ? "" : "s"}: ${missingEnvVars.join(", ")}`
          : "the value could not be resolved";
      throw new Error(`Failed to resolve ${label} "${key}": ${reason}`);
    }
    resolved[key] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersStrict(
  headers: Readonly<Record<string, string>> | undefined,
  env?: Readonly<Record<string, string | undefined>>,
  options?: ResolveConfigValueOptions,
): Record<string, string> | undefined {
  return resolveConfigRecordStrict(headers, env, { ...options, label: "header" });
}
