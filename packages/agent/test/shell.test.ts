import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { startCommand } from "../src/extensions/tasks/runner.ts";
import {
  createManagedExecutionEnv,
  killProcessTree,
  normalizePosixBashCommand,
  POWERSHELL_UTF8_PREAMBLE,
  resolveBashShell,
  resolvePowerShell,
  resolveWindowsBash,
  WINDOWS_POWERSHELL_EXIT_SUFFIX,
  waitForChildProcess,
} from "../src/shell/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-shell-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("normalizePosixBashCommand rewrites unquoted nul redirections on win32", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["echo hi >nul", "echo hi >/dev/null"],
    ["echo hi > nul", "echo hi > /dev/null"],
    ["cmd 2>nul", "cmd 2>/dev/null"],
    ["cmd 2> NUL", "cmd 2> /dev/null"],
    ["cmd 2>>nul", "cmd 2>>" + "/dev/null"],
    ["cmd 2>>  NUL", "cmd 2>>  /dev/null"],
    ["cmd &>nul", "cmd &>/dev/null"],
    ["cmd &>>nul", "cmd &>>/dev/null"],
    ["cmd 1>|Nul", "cmd 1>|/dev/null"],
    ["cat <nul", "cat </dev/null"],
    ["cat <>nul", "cat <>/dev/null"],
    ["cmd >&nul", "cmd >&/dev/null"],
    ["cmd 2>nul; echo ok", "cmd 2>/dev/null; echo ok"],
    ["cmd 2>nul&& echo ok", "cmd 2>/dev/null&& echo ok"],
    ["cmd 2>nul| cat", "cmd 2>/dev/null| cat"],
    ["(cmd 2>nul)", "(cmd 2>/dev/null)"],
    ["cmd 2>nul\necho ok", "cmd 2>/dev/null\necho ok"],
    ["cmd 2>nul\r\necho ok", "cmd 2>/dev/null\r\necho ok"],
    ["cmd 2>nul#comment", "cmd 2>/dev/null#comment"],
    ['echo "$(cmd 2>nul)"', 'echo "$(cmd 2>/dev/null)"'],
    ["echo foo#bar >nul", "echo foo#bar >/dev/null"],
  ];

  for (const [input, expected] of cases) {
    const res = normalizePosixBashCommand(input, "win32");
    assert.equal(res.command, expected, `input: ${input}`);
    assert.equal(res.rewrittenNul, true, `input: ${input}`);
  }
});

test("normalizePosixBashCommand preserves quotes, escapes, comments, heredocs, and non-nul words", () => {
  const unchangedCases = [
    'echo "2>nul crashes"',
    'echo "foo > nul"',
    "echo '2>nul'",
    "echo $'2>nul'",
    "echo $'foo\\' 2>nul'",
    "echo \\$'2>nul'",
    "printf 2\\>nul",
    "echo \\>nul",
    "echo 2>\\nul",
    'echo 2>"nul"',
    "echo 2>'nul'",
    "echo ok # 2>nul",
    "echo ok;# >nul",
    "echo >nullable",
    "echo >null",
    "echo >nul.txt",
    "echo >nul_1",
    "echo >nul-x",
    "echo >nul/sub",
    'echo >nul"x"',
    "cmd 2>&1",
    "cat <<<nul",
    'echo "$(echo "2>nul")"',
    "cat <<EOF\n2>nul\nEOF",
    "cat <<'EOF'\n2>nul\nEOF",
    'cat <<"EOF"\n2>nul\nEOF',
    "cat <<-EOF\n\t2>nul\n\tEOF",
    "cat <<EOF\r\n2>nul\r\nEOF",
  ];

  for (const input of unchangedCases) {
    const res = normalizePosixBashCommand(input, "win32");
    assert.equal(res.command, input, `input: ${input}`);
    assert.equal(res.rewrittenNul, false, `input: ${input}`);
  }
});

test("normalizePosixBashCommand rewrites same-line redirect before heredoc body while preserving body", () => {
  const input = "cat <<EOF 2>nul\n2>nul\nEOF\necho done >nul";
  const expected = "cat <<EOF 2>/dev/null\n2>nul\nEOF\necho done >/dev/null";
  const res = normalizePosixBashCommand(input, "win32");
  assert.equal(res.command, expected);
  assert.equal(res.rewrittenNul, true);

  const multi = "cat <<A <<B 2>nul\n>nul\nA\n2>nul\nB";
  const multiExpected = "cat <<A <<B 2>/dev/null\n>nul\nA\n2>nul\nB";
  assert.equal(normalizePosixBashCommand(multi, "win32").command, multiExpected);
});

test("normalizePosixBashCommand is a no-op on non-win32 platforms", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const res = normalizePosixBashCommand("cmd 2>nul", platform);
    assert.equal(res.command, "cmd 2>nul");
    assert.equal(res.rewrittenNul, false);
  }
});

test("resolveWindowsBash derives Git Bash from PATH git.exe without spawning git", async () => {
  await withTempDir(async (dir) => {
    const gitRoot = join(dir, "PortableGit");
    const cmdDir = join(gitRoot, "cmd");
    const binDir = join(gitRoot, "bin");
    await mkdir(cmdDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    // Non-executable dummy files prove discovery relies purely on filesystem checks, not spawning git.
    await writeFile(join(cmdDir, "git.exe"), "not-an-exe");
    await writeFile(join(binDir, "bash.exe"), "not-an-exe");

    const found = await resolveWindowsBash({
      env: { Path: cmdDir },
    });
    assert.equal(found, join(binDir, "bash.exe"));
  });
});

test("resolveWindowsBash handles ../usr/bin/bash.exe, ucrt64/bin/git.exe, and bin/bash.exe layouts", async () => {
  const usrBinPaths = new Set(["D:\\Git\\cmd\\git.exe", "D:\\Git\\usr\\bin\\bash.exe"]);
  assert.equal(
    await resolveWindowsBash({
      env: { PATH: "D:\\Git\\cmd" },
      pathExists: async (p) => usrBinPaths.has(p),
    }),
    "D:\\Git\\usr\\bin\\bash.exe",
  );

  const ucrtPaths = new Set([
    "C:\\Git\\ucrt64\\bin\\git.exe",
    "C:\\Git\\bin\\bash.exe",
    "C:\\Git\\usr\\bin\\bash.exe",
  ]);
  assert.equal(
    await resolveWindowsBash({
      env: { PATH: "C:\\Git\\ucrt64\\bin" },
      pathExists: async (p) => ucrtPaths.has(p),
    }),
    "C:\\Git\\bin\\bash.exe",
  );

  const rootPaths = new Set(["D:\\ToolsGit\\git.exe", "D:\\ToolsGit\\bin\\bash.exe"]);
  assert.equal(
    await resolveWindowsBash({
      env: { PATH: "D:\\ToolsGit" },
      pathExists: async (p) => rootPaths.has(p),
    }),
    "D:\\ToolsGit\\bin\\bash.exe",
  );
});

test("resolveWindowsBash prefers non-WSL bash.exe on PATH over legacy WSL launcher", async () => {
  const existing = new Set(["C:\\Windows\\System32\\bash.exe", "C:\\msys64\\usr\\bin\\bash.exe"]);
  const shell = await resolveWindowsBash({
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32;C:\\msys64\\usr\\bin",
    },
    pathExists: async (p) => existing.has(p),
  });
  assert.equal(shell, "C:\\msys64\\usr\\bin\\bash.exe");

  const onlyWsl = new Set(["C:\\Windows\\System32\\bash.exe"]);
  const wslShell = await resolveWindowsBash({
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    },
    pathExists: async (p) => onlyWsl.has(p),
  });
  assert.equal(wslShell, "C:\\Windows\\System32\\bash.exe");
});

test("resolveBashShell handles Windows WSL vs Git Bash and POSIX discovery order", async () => {
  const wsl = await resolveBashShell({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" },
    pathExists: async (p) => p === "C:\\Windows\\System32\\bash.exe",
  });
  assert.deepEqual(wsl, {
    shell: "C:\\Windows\\System32\\bash.exe",
    args: ["-s"],
    commandTransport: "stdin",
    isLegacyWsl: true,
  });

  const gitBash = await resolveBashShell({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: async (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
  });
  assert.deepEqual(gitBash, {
    shell: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["-c"],
    commandTransport: "argv",
    isLegacyWsl: false,
  });

  const posixPathBash = await resolveBashShell({
    platform: "linux",
    env: { PATH: "/opt/bin:/usr/bin" },
    pathExists: async (p) => p === "/opt/bin/bash",
  });
  assert.deepEqual(posixPathBash, {
    shell: "/opt/bin/bash",
    args: ["-c"],
    commandTransport: "argv",
    isLegacyWsl: false,
  });

  const posixShFallback = await resolveBashShell({
    platform: "darwin",
    env: {},
    pathExists: async (p) => p === "/bin/sh",
  });
  assert.deepEqual(posixShFallback, {
    shell: "/bin/sh",
    args: ["-c"],
    commandTransport: "argv",
    isLegacyWsl: false,
  });
});

test("resolvePowerShell prefers pwsh over Windows PowerShell and builds args properly", async () => {
  const both = new Set([
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);
  const pwsh = await resolvePowerShell({
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
    },
    pathExists: async (p) => both.has(p),
  });
  assert.ok(pwsh);
  assert.equal(pwsh.executable, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(pwsh.kind, "pwsh");
  assert.deepEqual(pwsh.buildArgs("Write-Output ok"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `${POWERSHELL_UTF8_PREAMBLE}Write-Output ok`,
  ]);

  const winPs = await resolvePowerShell({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    pathExists: async (p) => p === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
  assert.ok(winPs);
  assert.equal(winPs.kind, "windows-powershell");
  const args = winPs.buildArgs("git status");
  assert.equal(
    args.at(-1),
    `${POWERSHELL_UTF8_PREAMBLE}git status${WINDOWS_POWERSHELL_EXIT_SUFFIX}`,
  );
  const backtickArgs = winPs.buildArgs("echo hi `");
  assert.equal(backtickArgs.at(-1), `${POWERSHELL_UTF8_PREAMBLE}echo hi \``);

  const posixPwsh = await resolvePowerShell({
    platform: "linux",
    env: { PATH: "/usr/local/bin" },
    pathExists: async (p) => p === "/usr/local/bin/pwsh",
  });
  assert.ok(posixPwsh);
  assert.equal(posixPwsh.kind, "pwsh");
  assert.deepEqual(posixPwsh.buildArgs("echo 1"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `${POWERSHELL_UTF8_PREAMBLE}echo 1`,
  ]);
});

test("waitForChildProcess drains trailing output from detached grandchild without hanging", async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "grandchild.pid");
    // Spawn a child that launches a detached grandchild keeping stdout open for 15s,
    // writes a trailing line 25ms after child exits, and then stays quiet.
    const grandchildCode = [
      "setTimeout(() => process.stdout.write('trailing-output\\n'), 25);",
      "setTimeout(() => {}, 15000);",
    ].join(" ");
    const childCode = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {`,
      "  detached: true,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "  windowsHide: true,",
      "});",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      "g.unref();",
      "process.stdout.write('parent-output\\n');",
      "process.exit(0);",
    ].join(" ");

    const child = spawn(process.execPath, ["-e", childCode], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });

    const start = Date.now();
    const exitCode = await waitForChildProcess(child, { graceMs: 180, maxGraceMs: 1000 });
    const elapsedMs = Date.now() - start;

    const grandchildPid = Number.parseInt(
      await (await import("node:fs/promises")).readFile(pidFile, "utf8"),
      10,
    );
    killProcessTree(grandchildPid);

    assert.equal(exitCode, 0);
    assert.ok(output.includes("parent-output"), output);
    assert.ok(output.includes("trailing-output"), output);
    assert.ok(elapsedMs < 3000, `expected bounded settle, took ${elapsedMs}ms`);
  });
});

test("waitForChildProcess enforces maxGraceMs when grandchild keeps writing continuously", async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "noisy-grandchild.pid");
    const grandchildCode = "setInterval(() => process.stdout.write('tick\\n'), 20);";
    const childCode = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {`,
      "  detached: true,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "  windowsHide: true,",
      "});",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      "g.unref();",
      "process.exit(7);",
    ].join(" ");

    const child = spawn(process.execPath, ["-e", childCode], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.resume();
    child.stderr.resume();

    const start = Date.now();
    const exitCode = await waitForChildProcess(child, { graceMs: 80, maxGraceMs: 220 });
    const elapsedMs = Date.now() - start;

    const grandchildPid = Number.parseInt(
      await (await import("node:fs/promises")).readFile(pidFile, "utf8"),
      10,
    );
    killProcessTree(grandchildPid);

    assert.equal(exitCode, 7);
    assert.ok(elapsedMs < 2000, `expected maxGraceMs bound, took ${elapsedMs}ms`);
  });
});

test("killProcessTree terminates a process tree and tolerates invalid/dead PIDs", async () => {
  killProcessTree(0);
  killProcessTree(-5);
  killProcessTree(999_999_999);

  await withTempDir(async (dir) => {
    const readyFile = join(dir, "ready");
    const childCode = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const sub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(readyFile)}, String(sub.pid));`,
      "setTimeout(() => {}, 30000);",
    ].join(" ");

    const child = spawn(process.execPath, ["-e", childCode], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(readyFile), "child wrote ready file");
    const subPid = Number.parseInt(await readFile(readyFile, "utf8"), 10);
    assert.ok(child.pid !== undefined);

    killProcessTree(child.pid, { signal: "SIGTERM", forceAfterMs: 100 });
    const code = await waitForChildProcess(child, { graceMs: 50, maxGraceMs: 500 });
    assert.notEqual(code, 0);

    const killDeadline = Date.now() + 3000;
    let subAlive = true;
    while (Date.now() < killDeadline) {
      try {
        process.kill(subPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        subAlive = false;
        break;
      }
    }
    if (subAlive) killProcessTree(subPid);
    assert.equal(subAlive, false, "descendant process should be terminated");
  });
});

test("createManagedExecutionEnv executes commands with unified shell discovery without creating nul", async () => {
  await withTempDir(async (dir) => {
    const env = createManagedExecutionEnv({ cwd: dir });
    const chunks: string[] = [];
    const result = await env.exec(
      'echo "2>nul literal" && echo suppressed 2>nul',
      {
        onOutput: (text) => chunks.push(text),
      },
      BACKGROUND_CONTEXT,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.exitCode, 0);
    assert.ok(chunks.join("").includes("2>nul literal"));
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries, []);
    await env.cleanup(BACKGROUND_CONTEXT);
  });
});

test("createManagedExecutionEnv normalizes win32 string commands but leaves argv arrays untouched", async () => {
  await withTempDir(async (dir) => {
    const recorded: Array<string | readonly string[]> = [];
    const fakeInner = new NodeExecutionEnv({ cwd: dir });
    fakeInner.exec = async (command) => {
      recorded.push(command);
      return ok({ exitCode: 0 });
    };

    const winEnv = createManagedExecutionEnv({
      cwd: dir,
      platform: "win32",
      execEnv: fakeInner,
    });
    assert.ok(winEnv instanceof NodeExecutionEnv);

    await winEnv.exec("echo hi 2>nul", undefined, BACKGROUND_CONTEXT);
    await winEnv.exec(["pwsh", "-Command", "echo 2>nul"], undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(recorded, ["echo hi 2>/dev/null", ["pwsh", "-Command", "echo 2>nul"]]);

    const linuxRecorded: Array<string | readonly string[]> = [];
    const linuxInner = new NodeExecutionEnv({ cwd: dir });
    linuxInner.exec = async (command) => {
      linuxRecorded.push(command);
      return ok({ exitCode: 0 });
    };
    const linuxEnv = createManagedExecutionEnv({
      cwd: dir,
      platform: "linux",
      execEnv: linuxInner,
    });
    await linuxEnv.exec("echo hi 2>nul", undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(linuxRecorded, ["echo hi 2>nul"]);
  });
});

test("tasks startCommand normalizes win32 nul redirects while preserving logical command", async () => {
  await withTempDir(async (dir) => {
    const executed: string[] = [];
    const env = new NodeExecutionEnv({ cwd: dir });
    env.exec = async (command) => {
      executed.push(typeof command === "string" ? command : command.join(" "));
      return ok({ exitCode: 0 });
    };

    const running = startCommand(env, {
      command: 'echo "2>nul" && cmd 2>nul',
      platform: "win32",
    });
    const outcome = await running.done;
    assert.deepEqual(outcome, { kind: "exit", exitCode: 0 });
    assert.equal(running.command, 'echo "2>nul" && cmd 2>nul');
    assert.equal(running.rewrittenNul, true);
    assert.deepEqual(executed, ['echo "2>nul" && cmd 2>/dev/null']);
  });
});
