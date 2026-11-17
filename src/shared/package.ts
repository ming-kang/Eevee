import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);

export const version: string = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
).version;

const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

export const engineEntry = fileURLToPath(new URL(`../engine/main${extension}`, import.meta.url));

export function uiDir(): string | undefined {
  const dir = new URL("dist/ui/", root);
  return existsSync(new URL("index.html", dir)) ? fileURLToPath(dir) : undefined;
}
