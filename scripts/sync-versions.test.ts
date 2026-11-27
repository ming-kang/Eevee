import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("sync-versions.ts", import.meta.url));

type FixtureSpec = Record<string, { version?: string; dependencies?: Record<string, string> }>;

function fixture(spec: FixtureSpec): string {
  const root = mkdtempSync(join(tmpdir(), "eevee-sync-versions-"));
  for (const [path, manifest] of Object.entries(spec)) {
    const dir = join(root, path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: path, ...manifest }, null, 2)}\n`,
    );
  }
  return root;
}

function run(root: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function manifestAt(
  root: string,
  path: string,
): {
  version?: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
}

function withFixture(spec: FixtureSpec, fn: (root: string) => void): void {
  const root = fixture(spec);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const baseFixture: FixtureSpec = {
  "packages/alpha": { version: "0.1.0" },
  "packages/beta": { version: "0.1.0", dependencies: { "packages/alpha": "0.0.9" } },
  "apps/web": {
    version: "0.1.0",
    dependencies: { "packages/alpha": "0.0.9", "packages/beta": "0.1.0", react: "19.3.1" },
  },
};

test("rewrites internal dependency pins to the lockstep version and exits 0", () => {
  withFixture(baseFixture, (root) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(manifestAt(root, "packages/beta").dependencies?.["packages/alpha"], "0.1.0");
    assert.equal(manifestAt(root, "apps/web").dependencies?.["packages/alpha"], "0.1.0");
    assert.match(result.stdout, /Synced 2 internal dependency pin\(s\) to 0\.1\.0/);
  });
});

test("leaves already-synced pins and external dependencies untouched", () => {
  withFixture(baseFixture, (root) => {
    assert.equal(run(root).status, 0);
    assert.equal(manifestAt(root, "apps/web").dependencies?.["packages/beta"], "0.1.0");
    assert.equal(manifestAt(root, "apps/web").dependencies?.react, "19.3.1");
  });
});

test("is idempotent: a second run reports no updates", () => {
  withFixture(baseFixture, (root) => {
    assert.equal(run(root).status, 0);
    const second = run(root);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already in sync/);
  });
});

test("fails without modifying files when versions are not in lockstep", () => {
  const skewed: FixtureSpec = {
    "packages/alpha": { version: "0.1.0" },
    "packages/beta": { version: "0.2.0", dependencies: { "packages/alpha": "0.0.9" } },
  };
  withFixture(skewed, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not in lockstep/);
    assert.match(result.stderr, /packages\/alpha/);
    assert.equal(manifestAt(root, "packages/beta").dependencies?.["packages/alpha"], "0.0.9");
  });
});
