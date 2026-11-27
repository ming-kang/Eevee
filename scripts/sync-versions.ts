import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export type ManifestEntry = { file: string; pkg: Manifest };

export type VersionUpdate = {
  file: string;
  section: (typeof DEP_SECTIONS)[number];
  dependency: string;
  from: string;
};

export function collectWorkspaceManifests(root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(base, dir.name, "package.json");
      if (existsSync(file)) {
        entries.push({ file, pkg: JSON.parse(readFileSync(file, "utf8")) as Manifest });
      }
    }
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

export function syncVersions(root: string): { version: string; updates: VersionUpdate[] } {
  const manifests = collectWorkspaceManifests(root);
  if (manifests.length === 0) throw new Error(`No workspace packages found under ${root}`);

  const byVersion = new Map<string, string[]>();
  for (const { pkg } of manifests) {
    const version = pkg.version ?? "(missing)";
    byVersion.set(version, [...(byVersion.get(version) ?? []), pkg.name ?? "(unnamed)"]);
  }
  if (byVersion.size !== 1) {
    const details = [...byVersion.entries()]
      .map(([version, names]) => `  ${version}: ${names.join(", ")}`)
      .join("\n");
    throw new Error(
      `Workspace packages are not in lockstep:\n${details}\n` +
        "Realign with: npm version <x.y.z> --workspaces --no-git-tag-version --no-workspaces-update",
    );
  }
  const version = manifests[0]?.pkg.version;
  if (version === undefined) throw new Error("Workspace packages have no version field");

  const workspaceNames = new Set(manifests.map(({ pkg }) => pkg.name));
  const updates: VersionUpdate[] = [];
  const dirty = new Set<ManifestEntry>();

  for (const entry of manifests) {
    for (const section of DEP_SECTIONS) {
      const deps = entry.pkg[section];
      if (!deps) continue;
      for (const [dependency, specifier] of Object.entries(deps)) {
        if (!workspaceNames.has(dependency) || specifier === version) continue;
        deps[dependency] = version;
        updates.push({ file: entry.file, section, dependency, from: specifier });
        dirty.add(entry);
      }
    }
  }

  for (const entry of dirty) {
    writeFileSync(entry.file, `${JSON.stringify(entry.pkg, null, 2)}\n`);
  }
  return { version, updates };
}

function main(): void {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  const { version, updates } = syncVersions(root);
  for (const update of updates) {
    const label = relative(root, update.file).replaceAll("\\", "/");
    console.log(`${label}: ${update.dependency} ${update.from} -> ${version} (${update.section})`);
  }
  console.log(
    updates.length === 0
      ? `All workspace packages are at ${version}; internal dependencies already in sync.`
      : `Synced ${updates.length} internal dependency pin(s) to ${version}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
