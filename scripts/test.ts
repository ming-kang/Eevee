import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROOTS = ["packages", "apps", "scripts"];
const IGNORED = new Set(["node_modules", "dist", ".git"]);

function collectTests(target: string): string[] {
  const full = resolve(root, target);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (stat.isFile()) return full.endsWith(".test.ts") ? [full] : [];
  const found: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const child = join(full, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(child));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(child);
  }
  return found;
}

const rawArgs = process.argv.slice(2);
const targets: string[] = [];
const passthrough: string[] = [];
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  if (arg === undefined) continue;
  if (arg === "--") {
    passthrough.push(...rawArgs.slice(index + 1));
    break;
  }
  if (arg.startsWith("-")) {
    passthrough.push(arg);
  } else {
    targets.push(arg);
  }
}

const files = (targets.length > 0 ? targets : DEFAULT_ROOTS).flatMap(collectTests).sort();
if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--conditions=eevee-source", "--test", ...passthrough, ...files],
  {
    cwd: root,
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
