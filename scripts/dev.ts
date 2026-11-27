import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = join(root, "apps", "cli", "src", "index.ts");
const webDir = join(root, "apps", "web");
const webDistIndex = join(webDir, "dist", "index.html");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");

export function requiresWebDist(args: readonly string[]): boolean {
  const command = args[0];
  return command === undefined || command === "start" || command === "web";
}

function buildWeb(): void {
  if (!existsSync(viteBin)) {
    throw new Error(`Vite is missing: ${viteBin}. Run 'npm install' in ${root}.`);
  }
  const result = spawnSync(process.execPath, [viteBin, "build"], { cwd: webDir, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Web UI build failed");
}

function ensureWebDist(): void {
  if (existsSync(webDistIndex)) return;
  console.log("Web UI not built yet; building apps/web (first run only)...");
  buildWeb();
}

function runCli(args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--conditions=eevee-source", cliEntry, ...args], {
      stdio: "inherit",
    });
    child.on("error", () => resolvePromise(1));
    child.on("exit", (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)));
  });
}

function printDevHints(): void {
  console.log(`\nDevelopment source: ${root}`);
  console.log("  build             rebuild the web UI after frontend changes");
  console.log("  (no arguments)    start the engine and open the web UI");
  console.log("For hot-reload web development, run 'npm run dev:web' in a separate terminal;");
  console.log("the Vite dev server on 127.0.0.1:5173 proxies API calls to the engine.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "build") {
    if (args.length !== 1) throw new Error("Usage: dev build");
    buildWeb();
    return;
  }

  if (requiresWebDist(args)) ensureWebDist();

  if (args.length === 0) {
    const startCode = await runCli(["start"]);
    if (startCode !== 0) {
      process.exitCode = startCode;
      return;
    }
    process.exitCode = await runCli(["web", "--open"]);
    return;
  }

  process.exitCode = await runCli(args);
  if (args.some((arg) => ["help", "--help", "-h"].includes(arg))) {
    printDevHints();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
