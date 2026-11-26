import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
  type BashToolOptions,
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
  type ImageProcessor,
  type PowerShellToolOptions,
} from "@earendil-works/pi-durable/tools";
import { withToolPromptMeta } from "../../context/tool-meta.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";

export const CODING_TOOLS_EXTENSION = "eevee.coding-tools";
export const READONLY_TOOLS_EXTENSION = "eevee.readonly-tools";

export type CodingToolsOptions = {
  readonly images?: ImageProcessor;
  readonly bash?: BashToolOptions;
  readonly powerShell?: boolean | PowerShellToolOptions;
  readonly searchTools?: boolean;
};

function lazyPhotonImages(): ImageProcessor {
  let pending: Promise<ImageProcessor> | undefined;
  const load = () => {
    pending ??= createNodePhotonImages();
    return pending;
  };
  return {
    prepare: async (bytes, mimeType, limits) => (await load()).prepare(bytes, mimeType, limits),
  };
}

function readTool(images: ImageProcessor | undefined) {
  return withToolPromptMeta(createReadTool({ images: images ?? lazyPhotonImages() }), {
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use read to inspect files before changing them, and instead of cat or sed.",
      "Use offset and limit for large files instead of loading them whole.",
    ],
  });
}

export function createReadonlyToolsExtension(options?: { images?: ImageProcessor }) {
  return defineExtension({
    name: READONLY_TOOLS_EXTENSION,
    tools: [readTool(options?.images), lsTool, findTool, grepTool],
  });
}

export function createCodingToolsExtension(options: CodingToolsOptions = {}) {
  const writeTool = withToolPromptMeta(createWriteTool(), {
    promptSnippet: "Create or overwrite files",
    promptGuidelines: [
      "Use write only for new files or complete rewrites; prefer edit for changes to existing files.",
    ],
  });
  const editTool = withToolPromptMeta(createEditTool(), {
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for targeted changes and batch edits to one file in a single call.",
      "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
    ],
  });
  const bashTool = withToolPromptMeta(createBashTool(options.bash), {
    promptSnippet: "Execute bash commands",
    promptGuidelines: [
      "Use bash for builds, tests, and system commands. Quote paths with spaces, prefer non-interactive commands, and use POSIX shell syntax (/dev/null, not NUL or $null).",
    ],
  });
  const tools: ToolRegistration[] = [readTool(options.images), writeTool, editTool, bashTool];
  if (options.powerShell !== undefined && options.powerShell !== false) {
    const powerShellTool = withToolPromptMeta(
      createPowerShellTool(options.powerShell === true ? {} : options.powerShell) as never,
      {
        promptSnippet: "Execute PowerShell commands",
        promptGuidelines: [
          "Use powershell for PowerShell scripts and Windows-native commands; prefer non-interactive commands.",
          "powershell uses PowerShell syntax ($null rather than /dev/null or NUL).",
        ],
      },
    );
    tools.push(powerShellTool);
  }
  if (options.searchTools === true) tools.push(lsTool, findTool, grepTool);
  return defineExtension({
    name: CODING_TOOLS_EXTENSION,
    tools,
  });
}

export { matchGlob, walkFiles } from "./listings.ts";
export { findTool, grepTool, lsTool };
