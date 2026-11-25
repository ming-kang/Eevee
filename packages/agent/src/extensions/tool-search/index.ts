import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension as createUpstreamToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

export const TOOL_SEARCH_EXTENSION = "eevee.tool-search";

export function createToolSearchExtension(): Extension {
  const upstream = createUpstreamToolSearchExtension();
  return defineExtension({ ...upstream, name: TOOL_SEARCH_EXTENSION });
}

export type { ToolSearchToolDetails } from "@earendil-works/pi-durable/tool-search";
export {
  createToolSearchTool,
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
