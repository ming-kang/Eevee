import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { browseDirs } from "./browse.ts";

test("browse lists a directory's subdirectories, names its parent, and refuses non-directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-browse-"));
  try {
    await mkdir(join(home, "inner"));
    await mkdir(join(home, "second"));
    await writeFile(join(home, "file.txt"), "x");

    const listing = await browseDirs(home);
    assert.equal(listing.path, resolve(home));
    assert.equal(listing.parent, dirname(resolve(home)));
    assert.deepEqual(
      listing.dirs.map((dir) => dir.name),
      ["inner", "second"],
    );
    assert.deepEqual(
      listing.dirs.map((dir) => dir.path),
      [resolve(home, "inner"), resolve(home, "second")],
    );

    const roots = await browseDirs("");
    assert.equal(roots.path, "");
    assert.ok(roots.dirs.length > 0);

    await assert.rejects(browseDirs(join(home, "missing")), {
      problem: { code: "no_dir", path: resolve(home, "missing") },
    });
    await assert.rejects(browseDirs(join(home, "file.txt")), {
      problem: { code: "not_dir", path: resolve(home, "file.txt") },
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
