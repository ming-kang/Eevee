import { defineExtension } from "@earendil-works/pi-durable";
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
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";

export const CODING_TOOLS_EXTENSION = "eevee.coding-tools";
export const READONLY_TOOLS_EXTENSION = "eevee.readonly-tools";

export type CodingToolsOptions = {
  readonly images?: ImageProcessor;
  readonly bash?: BashToolOptions;
  readonly powerShell?: boolean | PowerShellToolOptions;
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
  return createReadTool({ images: images ?? lazyPhotonImages() });
}

export function createReadonlyToolsExtension(options?: { images?: ImageProcessor }) {
  return defineExtension({
    name: READONLY_TOOLS_EXTENSION,
    tools: [readTool(options?.images), lsTool, findTool, grepTool],
  });
}

export function createCodingToolsExtension(options: CodingToolsOptions = {}) {
  const tools = [
    readTool(options.images),
    createWriteTool(),
    createEditTool(),
    createBashTool(options.bash),
  ];
  if (options.powerShell !== undefined && options.powerShell !== false) {
    tools.push(
      createPowerShellTool(options.powerShell === true ? {} : options.powerShell) as never,
    );
  }
  return defineExtension({
    name: CODING_TOOLS_EXTENSION,
    tools,
  });
}

export { matchGlob, walkFiles } from "./listings.ts";
export { findTool, grepTool, lsTool };
