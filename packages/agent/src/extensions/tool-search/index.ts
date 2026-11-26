import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import {
  createToolSearchExtension as createUpstreamToolSearchExtension,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import { withToolPromptMeta } from "../../context/tool-meta.ts";

export const TOOL_SEARCH_EXTENSION = "eevee.tool-search";

export function createToolSearchExtension(): Extension {
  const upstream = createUpstreamToolSearchExtension();
  const tools = (upstream.tools ?? []).map((tool) =>
    tool.name === TOOL_SEARCH_TOOL_NAME
      ? withToolPromptMeta(tool, {
          promptSnippet: "Search for deferred tools that are not loaded yet and load the matches",
          promptGuidelines: [
            "Use tool_search to discover and load deferred tools (including MCP server tools listed in mcp_servers) before calling them directly.",
          ],
        })
      : tool,
  );
  return defineExtension({ ...upstream, name: TOOL_SEARCH_EXTENSION, tools });
}

export type { ToolSearchToolDetails } from "@earendil-works/pi-durable/tool-search";
export {
  createToolSearchTool,
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
