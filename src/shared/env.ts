/**
 * Variables a child process (a `bash` command, a background job, an MCP server) inherits from the Engine.
 * Credentials the Engine holds stay out of them; this lowers accidental leaks and is no isolation boundary.
 */
const SAFE_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "USER",
  "USERNAME",
];

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
