import { defineExtension, hook, type JsonObject, ToolTask } from "@earendil-works/pi-durable";
import {
  createMountLoader,
  type Mount,
  type MountLoaderOptions,
  rewriteMsysPath,
} from "../../shell/index.ts";

export const SHELL_PATHS_EXTENSION = "eevee.shell-paths";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

export type ShellPathsOptions = MountLoaderOptions & {
  readonly platform?: NodeJS.Platform;
};

export function rewriteToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  mounts: readonly Mount[],
): Record<string, unknown> | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;
  const path = args.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined;
  const rewritten = rewriteMsysPath(path, mounts);
  if (rewritten === path) return undefined;
  return { ...args, path: rewritten };
}

export function createShellPathsExtension(options: ShellPathsOptions = {}) {
  const loadMounts = createMountLoader(options);

  return defineExtension({
    name: SHELL_PATHS_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const platform = options.platform ?? process.platform;
          if (platform !== "win32") return undefined;
          const mounts = await loadMounts();
          const rewritten = rewriteToolArguments(call.name, call.arguments, mounts);
          if (rewritten === undefined) return undefined;
          return { arguments: rewritten as JsonObject };
        },
      }),
    ],
  });
}
