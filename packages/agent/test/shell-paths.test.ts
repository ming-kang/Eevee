import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShellPathsExtension,
  parseMounts,
  rewriteDrivePath,
  rewriteMsysPath,
  rewriteToolArguments,
  toWindowsPath,
} from "../src/extensions/shell-paths/index.ts";

test("parseMounts parses mount output, keeps Windows sources, longest point first", () => {
  const mounts = parseMounts(
    [
      "C:\\Program Files\\Git on / type ntfs (binary,noacl,auto)",
      "C:\\Users\\x\\AppData\\Local\\Temp on /tmp type ntfs (binary,noacl,auto)",
      "usr on /usr type ntfs (binary,noacl,auto)",
      "C:\\ on /c type ntfs (binary,noacl,posix=0,user)",
      "",
    ].join("\n"),
  );
  assert.equal(mounts.length, 3);
  assert.equal(mounts[0]?.point, "/tmp");
  const root = mounts.find((mount) => mount.point === "/");
  assert.ok(root?.target.startsWith("C:"));
  assert.ok(!mounts.some((mount) => mount.point === "/usr" && mount.target === "usr"));
});

test("toWindowsPath resolves the longest matching mount point", () => {
  const mounts = parseMounts(
    "C:\\Git on / type ntfs (binary)\nC:\\Temp on /tmp type ntfs (binary)\n",
  );
  assert.equal(toWindowsPath("/tmp/x.txt", mounts), "C:\\Temp\\x.txt");
  assert.equal(toWindowsPath("/usr/bin/env", mounts), "C:\\Git\\usr\\bin\\env");
  assert.equal(toWindowsPath("/tmp", mounts), "C:\\Temp");
});

test("rewriteDrivePath converts drive-letter mounts only", () => {
  assert.equal(rewriteDrivePath("/c/Users/x"), "C:\\Users\\x");
  assert.equal(rewriteDrivePath("/d"), "D:\\");
  assert.equal(rewriteDrivePath("/tmp/x"), undefined);
  assert.equal(rewriteDrivePath("relative"), undefined);
});

test("rewriteMsysPath prefers the mount table and falls back to drive letters", () => {
  const mounts = parseMounts("C:\\Temp on /tmp type ntfs (binary)\n");
  assert.equal(rewriteMsysPath("/tmp/a.txt", mounts), "C:\\Temp\\a.txt");
  assert.equal(rewriteMsysPath("/c/Users/x", mounts), "C:\\Users\\x");
  assert.equal(rewriteMsysPath("/c/Users/x"), "C:\\Users\\x");
  assert.equal(rewriteMsysPath("C:/already", mounts), "C:/already");
});

test("rewriteToolArguments rewrites path arguments of file tools only", () => {
  const mounts = parseMounts("C:\\Temp on /tmp type ntfs (binary)\n");
  assert.deepEqual(rewriteToolArguments("read", { path: "/tmp/a.txt", offset: 1 }, mounts), {
    path: "C:\\Temp\\a.txt",
    offset: 1,
  });
  assert.equal(rewriteToolArguments("bash", { command: "/tmp/x" }, mounts), undefined);
  assert.equal(rewriteToolArguments("read", { path: "relative.txt" }, mounts), undefined);
  assert.equal(rewriteToolArguments("read", { path: "//unc/share" }, mounts), undefined);
  assert.equal(rewriteToolArguments("read", { offset: 1 }, mounts), undefined);
  assert.deepEqual(
    rewriteToolArguments("grep", { path: "/e/work", pattern: "x" }, [])?.path,
    "E:\\work",
  );
});

test("drive-letter paths beat the generic root mount fallback", () => {
  const mounts = parseMounts(
    "C:\\Program Files\\Git on / type ntfs (binary)\nC:\\ on /c type ntfs (binary)\n",
  );
  assert.equal(rewriteMsysPath("/d/work/a.txt", mounts), "D:\\work\\a.txt");
  assert.deepEqual(rewriteToolArguments("read", { path: "/e/work" }, mounts)?.path, "E:\\work");
  assert.equal(rewriteMsysPath("/tmp/a.txt", mounts), "C:\\Program Files\\Git\\tmp\\a.txt");
});

test("createShellPathsExtension exposes the eevee.shell-paths hook extension", () => {
  const extension = createShellPathsExtension();
  assert.equal(extension.name, "eevee.shell-paths");
  assert.equal((extension.hooks ?? []).length, 1);
});
