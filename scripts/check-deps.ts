import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, string | { "eevee-source"?: string; import?: string; types?: string }>;
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file: string): Manifest {
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

function collectManifests(): string[] {
  const manifests = [join(root, "package.json")];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, "package.json");
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests.sort();
}

const manifests = collectManifests();
const workspaces = new Map<string, { file: string; dir: string; pkg: Manifest }>();
for (const file of manifests.slice(1)) {
  const pkg = readJson(file);
  workspaces.set(pkg.name, { file, dir: dirname(file), pkg });
}

const PI_CORE_EARENDIL = /^@earendil-works\/(?:chord|pi-.+)$/;

const failures: string[] = [];
const piCoreVersions = new Map<string, string[]>();

for (const file of manifests) {
  const label = relative(root, file).replace(/\\/g, "/");
  const pkg = readJson(file);

  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (!EXACT_SEMVER.test(specifier)) {
        failures.push(
          `${label}: ${section}.${name} must be an exact pinned version, found "${specifier}"`,
        );
        continue;
      }
      if (PI_CORE_EARENDIL.test(name)) {
        const list = piCoreVersions.get(specifier) ?? [];
        list.push(`${label} (${name})`);
        piCoreVersions.set(specifier, list);
      }
      if (name.startsWith("@eevee/")) {
        const target = workspaces.get(name);
        if (!target) {
          failures.push(`${label}: ${section}.${name} does not match any workspace package`);
        } else if (target.pkg.version !== specifier) {
          failures.push(
            `${label}: ${section}.${name} version "${specifier}" does not match workspace version "${target.pkg.version}"`,
          );
        }
      }
    }
  }

  if (pkg.exports) {
    const dir = dirname(file);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const sourcePath =
        typeof target === "object" && target !== null ? target["eevee-source"] : undefined;
      if (typeof sourcePath === "string" && !existsSync(resolve(dir, sourcePath))) {
        failures.push(
          `${label}: exports["${subpath}"]["eevee-source"] points to missing file "${sourcePath}"`,
        );
      }
    }
  }
}

if (piCoreVersions.size > 1) {
  const detail = [...piCoreVersions.entries()]
    .map(([version, refs]) => `  ${version}: ${refs.join(", ")}`)
    .join("\n");
  failures.push(
    `All Pi @earendil-works/{chord,pi-*} packages must share one exact version:\n${detail}`,
  );
}

if (failures.length > 0) {
  console.error("Dependency check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
