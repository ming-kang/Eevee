import { defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { type BackgroundJobs, createBashTool } from "./bash.ts";

export type { BackgroundJobs, CommandResult, RunningCommand } from "./bash.ts";

export const WORKSPACE_TOOLS = { write: "write", edit: "edit", bash: "bash" } as const;

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

export type WorkspaceDeps = {
  backgroundAfterMs: () => number;
  jobs: BackgroundJobs;
};

export function createWorkspace(deps: WorkspaceDeps) {
  const bash = createBashTool({ ...deps, env: () => scrubbedEnv() });
  return defineExtension({
    name: "eevee.workspace",
    tools: [createWriteTool(), createEditTool(), bash],
  });
}
