import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function bin(pkg, name = pkg) {
  const manifest = require.resolve(`${pkg}/package.json`);
  const { bin } = require(manifest);
  return join(dirname(manifest), typeof bin === "string" ? bin : bin[name]);
}

const steps = [
  [bin("typescript", "tsc"), "-p", "tsconfig.build.json"],
  [bin("vite"), "build", "--config", "web/vite.config.ts"],
];

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
for (const [entry, ...args] of steps) {
  console.log(`> ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
