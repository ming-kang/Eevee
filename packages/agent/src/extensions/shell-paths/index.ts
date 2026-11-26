import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import {
  createMountLoader,
  isLegacyWslBashPath,
  type Mount,
  type MountLoaderOptions,
  parseMounts,
  type ResolveWindowsBashOptions,
  resolveWindowsBash,
  rewriteDrivePath,
  rewriteMsysPath,
  toWindowsPath,
} from "../../shell/index.ts";

export const SHELL_PATHS_EXTENSION = "eevee.shell-paths";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

export {
  isLegacyWslBashPath,
  type Mount,
  parseMounts,
  type ResolveWindowsBashOptions,
  resolveWindowsBash,
  rewriteDrivePath,
  rewriteMsysPath,
  toWindowsPath,
};

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
          const args = call.arguments as Record<string, unknown>;
          const mounts = await loadMounts();
          const rewritten = rewriteToolArguments(call.name, args, mounts);
          if (rewritten === undefined) return undefined;
          return { arguments: rewritten as never };
        },
      }),
    ],
  });
}
