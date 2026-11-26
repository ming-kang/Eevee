import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createShellPathsExtension,
  isLegacyWslBashPath,
  parseMounts,
  resolveWindowsBash,
  rewriteDrivePath,
  rewriteMsysPath,
  rewriteToolArguments,
  toWindowsPath,
} from "../src/extensions/shell-paths/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-shell-paths-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type BeforeTool = (call: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<{ arguments?: Record<string, unknown> } | undefined>;

function beforeToolOf(extension: ReturnType<typeof createShellPathsExtension>): BeforeTool {
  const registration = extension.hooks?.[0];
  assert.ok(registration !== undefined);
  const handlers = registration.handlers as {
    beforeTool: (
      call: unknown,
      api: unknown,
      context: unknown,
    ) => Promise<{ arguments?: Record<string, unknown> } | undefined>;
  };
  return (call) => handlers.beforeTool(call, undefined, undefined);
}

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

test("isLegacyWslBashPath matches wsl.exe launchers", () => {
  assert.equal(isLegacyWslBashPath("wsl.exe"), true);
  assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\wsl.exe"), true);
  assert.equal(isLegacyWslBashPath("C:/Windows/System32/WSL.EXE"), true);
  assert.equal(isLegacyWslBashPath("C:\\tools\\bashwsl.exe"), false);
  assert.equal(isLegacyWslBashPath("C:\\Program Files\\Git\\bin\\bash.exe"), false);
});

test("isLegacyWslBashPath matches System32 and Sysnative bash under a valid SystemRoot", () => {
  assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe", "C:\\Windows"), true);
  assert.equal(isLegacyWslBashPath("c:\\windows\\sysnative\\bash.exe", "C:\\WINDOWS"), true);
  assert.equal(isLegacyWslBashPath("D:\\Windows\\System32\\bash.exe", "C:\\Windows"), false);
  assert.equal(
    isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe", "D:\\Windows"),
    false,
    "a valid SystemRoot disables the conventional-path fallback",
  );
});

test("isLegacyWslBashPath falls back to conventional paths when SystemRoot is absent or invalid", () => {
  assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe"), true);
  assert.equal(isLegacyWslBashPath("D:\\Windows\\SysNative\\bash.exe"), true);
  assert.equal(isLegacyWslBashPath("E:\\Windows\\System32\\bash.exe", ""), true);
  assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe", "system32"), true);
  assert.equal(isLegacyWslBashPath("C:\\Git\\bin\\bash.exe"), false);
  assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.com"), false);
});

test("resolveWindowsBash returns an explicit shellPath when it exists", async () => {
  const shell = await resolveWindowsBash({
    shellPath: "D:\\tools\\bash.exe",
    env: {},
    pathExists: async () => true,
    findOnPath: async () => "C:\\on-path\\bash.exe",
  });
  assert.equal(shell, "D:\\tools\\bash.exe");
});

test("resolveWindowsBash stops at a missing explicit shellPath without falling through", async () => {
  const shell = await resolveWindowsBash({
    shellPath: "D:\\missing\\bash.exe",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: async (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
    findOnPath: async () => "C:\\on-path\\bash.exe",
  });
  assert.equal(shell, undefined);
});

test("resolveWindowsBash prefers the ProgramFiles Git bash over ProgramFiles(x86) and PATH", async () => {
  const shell = await resolveWindowsBash({
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    pathExists: async () => true,
    findOnPath: async () => "C:\\on-path\\bash.exe",
  });
  assert.equal(shell, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("resolveWindowsBash falls back to the ProgramFiles(x86) Git bash", async () => {
  const shell = await resolveWindowsBash({
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    pathExists: async (path) => path === "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    findOnPath: async () => "C:\\on-path\\bash.exe",
  });
  assert.equal(shell, "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
});

test("resolveWindowsBash uses the PATH lookup when no Git bash exists", async () => {
  const shell = await resolveWindowsBash({
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: async () => false,
    findOnPath: async () => "C:\\msys64\\usr\\bin\\bash.exe",
  });
  assert.equal(shell, "C:\\msys64\\usr\\bin\\bash.exe");
});

test("resolveWindowsBash returns undefined when no bash is found", async () => {
  const shell = await resolveWindowsBash({
    env: {},
    pathExists: async () => false,
    findOnPath: async () => undefined,
  });
  assert.equal(shell, undefined);
});

test("beforeTool rewrites through the resolved shell's mount table", async () => {
  await withTempDir(async (dir) => {
    const mountLine = "D:\\fakebash on / type ntfs (binary,noacl,auto)\n";
    const scriptPath = join(dir, "fake-bash.cjs");
    await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(mountLine)});\n`);
    const beforeTool = beforeToolOf(
      createShellPathsExtension({
        platform: "win32",
        shellPath: process.execPath,
        shellArgs: [scriptPath],
        env: {},
      }),
    );
    const rewritten = await beforeTool({ name: "read", arguments: { path: "/usr/bin/x.txt" } });
    assert.equal(rewritten?.arguments?.path, "D:\\fakebash\\usr\\bin\\x.txt");
  });
});

test("beforeTool skips the mount probe when the resolved shell is a legacy WSL bash", async () => {
  const beforeTool = beforeToolOf(
    createShellPathsExtension({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      pathExists: async () => true,
      findOnPath: async () => "C:\\Windows\\System32\\bash.exe",
    }),
  );
  assert.equal(
    await beforeTool({ name: "read", arguments: { path: "/usr/bin/x.txt" } }),
    undefined,
    "without a mount table there is no root mount to rewrite against",
  );
  const drive = await beforeTool({ name: "read", arguments: { path: "/c/Users/x" } });
  assert.equal(drive?.arguments?.path, "C:\\Users\\x");
});

test("beforeTool rewrites drive letters only when no bash resolves", async () => {
  const beforeTool = beforeToolOf(
    createShellPathsExtension({
      platform: "win32",
      env: {},
      pathExists: async () => false,
      findOnPath: async () => undefined,
    }),
  );
  assert.equal(
    await beforeTool({ name: "read", arguments: { path: "/usr/bin/x.txt" } }),
    undefined,
  );
  const drive = await beforeTool({ name: "read", arguments: { path: "/e/work" } });
  assert.equal(drive?.arguments?.path, "E:\\work");
});
