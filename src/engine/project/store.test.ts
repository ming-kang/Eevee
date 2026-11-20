import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eeveePaths } from "../../shared/paths.ts";
import { createProjectMeta, listProjects } from "./store.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eevee-store-"));
}

test("a project.json saved with the old single workspace migrates to workspaces on read", async () => {
  const home = await tempHome();
  try {
    const paths = eeveePaths(home);
    const dir = join(home, "ws");
    await mkdir(dir, { recursive: true });
    await mkdir(paths.project("p1").root, { recursive: true });
    await writeFile(
      paths.project("p1").meta,
      JSON.stringify({ id: "p1", title: "Legacy", workspace: dir, createdAt: 1 }),
    );
    const [read] = await listProjects(paths);
    assert.equal(read?.title, "Legacy");
    assert.deepEqual(read?.workspaces, [dir]);
    const saved = JSON.parse(await readFile(paths.project("p1").meta, "utf8")) as {
      workspaces?: string[];
      workspace?: string;
    };
    assert.deepEqual(saved.workspaces, [dir]);
    assert.equal(saved.workspace, undefined);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("createProjectMeta resolves and dedupes workspaces, and rejects non-directories", async () => {
  const home = await tempHome();
  try {
    const paths = eeveePaths(home);
    const dirA = join(home, "a");
    const dirB = join(home, "b");
    await mkdir(dirA);
    await mkdir(dirB);
    const meta = await createProjectMeta(paths, {
      title: "Both",
      workspaces: [dirA, `${dirA}/`, dirB, dirB],
    });
    assert.deepEqual(meta.workspaces, [resolve(dirA), resolve(dirB)]);

    await assert.rejects(createProjectMeta(paths, { title: "None", workspaces: [] }), {
      problem: { code: "required", field: "workspaces" },
    });
    await assert.rejects(createProjectMeta(paths, { title: "Blank", workspaces: ["  "] }), {
      problem: { code: "required", field: "workspaces" },
    });
    await assert.rejects(
      createProjectMeta(paths, { title: "Missing", workspaces: [join(home, "missing")] }),
      { problem: { code: "no_dir", path: resolve(home, "missing") } },
    );
    const file = join(home, "file.txt");
    await writeFile(file, "x");
    await assert.rejects(createProjectMeta(paths, { title: "File", workspaces: [file] }), {
      problem: { code: "not_dir", path: resolve(file) },
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
