import { type Dirent, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function workspaceDirs(): string[] {
  const dirs = [root];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name));
    }
  }
  return dirs;
}

for (const dir of workspaceDirs()) {
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      rmSync(join(dir, entry.name), { force: true });
    }
  }
}
