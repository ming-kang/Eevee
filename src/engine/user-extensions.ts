/**
 * User extensions: every `*.ts`, `*.js` or `*.mjs` file in `~/.eevee/extensions/`, whose default export is a Durable
 * extension or a function returning one. They are installed in every project and enabled per role by name, like MCP
 * servers. Names Eevee uses itself (`eevee.*`, `mcp.*`, `tool-search`, `codemode`) are refused.
 *
 * ```ts
 * import { defineExtension, defineTool } from "@earendil-works/pi-durable";
 * export default defineExtension({ name: "weather", tools: [defineTool({ ... })] });
 * ```
 */
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { type ConfigIssue, describeConfigIssue } from "../contracts/index.ts";
import { ConfigError, configIssue } from "../shared/config.ts";

export type UserExtensionStatus = {
  file: string;
  name?: string;
  tools: number;
  error?: ConfigIssue;
};

const SOURCE = new Set([".ts", ".js", ".mjs"]);
const RESERVED = [/^eevee\./, /^mcp\./, /^tool-search$/, /^codemode$/];

export async function loadUserExtensions(
  dir: string,
): Promise<{ extensions: Extension[]; status: UserExtensionStatus[] }> {
  const files = await sourceFiles(dir);
  const extensions: Extension[] = [];
  const status: UserExtensionStatus[] = [];
  for (const file of files) {
    try {
      const extension = await loadOne(dir, file);
      if (extensions.some((e) => e.name === extension.name)) {
        throw new ConfigError([{ file, code: "name_taken", name: extension.name }]);
      }
      extensions.push(extension);
      status.push({ file, name: extension.name, tools: extension.tools?.length ?? 0 });
    } catch (error) {
      const issue = configIssue(error);
      console.error(`[extensions] ${file} failed to load: ${describeConfigIssue(issue)}`);
      status.push({ file, tools: 0, error: issue });
    }
  }
  return { extensions, status };
}

async function sourceFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && SOURCE.has(extname(e.name)) && !e.name.endsWith(".d.ts"))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadOne(dir: string, file: string): Promise<Extension> {
  const module = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
  const exported = module.default;
  const value = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  if (!isExtension(value)) throw new ConfigError([{ file, code: "bad_export" }]);
  if (RESERVED.some((pattern) => pattern.test(value.name))) {
    throw new ConfigError([{ file, code: "name_reserved", name: value.name }]);
  }
  return value;
}

function isExtension(value: unknown): value is Extension {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.trim() !== ""
  );
}
