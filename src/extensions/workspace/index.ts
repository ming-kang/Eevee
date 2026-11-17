import { defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { scrubbedEnv } from "../../shared/env.ts";
import { type BackgroundJobs, createBashTool } from "./bash.ts";

export type { BackgroundJobs, CommandResult, RunningCommand } from "./bash.ts";

export const WORKSPACE_EXTENSION = "eevee.workspace";

export type WorkspaceDeps = {
  backgroundAfterMs: () => number;
  jobs: BackgroundJobs;
};

/** `write`, `edit` and `bash` in the conversation's working directory; long commands become background jobs. */
export function createWorkspace(deps: WorkspaceDeps) {
  const bash = createBashTool({ ...deps, env: () => scrubbedEnv() });
  return defineExtension({
    name: WORKSPACE_EXTENSION,
    tools: [createWriteTool(), createEditTool(), bash],
  });
}
