export const AGENT_EXTENSIONS = {
  readonlyTools: "eevee.readonly-tools",
  codingTools: "eevee.coding-tools",
  shellPaths: "eevee.shell-paths",
  tasks: "eevee.tasks",
  codemode: "eevee.codemode",
  toolSearch: "eevee.tool-search",
  mcp: "eevee.mcp",
  cachedCompaction: "eevee.cached-compaction",
} as const;

export type AgentExtensionName = (typeof AGENT_EXTENSIONS)[keyof typeof AGENT_EXTENSIONS];

export const READONLY_TOOLS = ["read", "ls", "find", "grep"] as const;
export const CODING_TOOLS = ["read", "write", "edit", "bash"] as const;
export const TASKS_TOOLS = ["tasks"] as const;
export const CODEMODE_TOOLS = ["codemode"] as const;
export const TOOL_SEARCH_TOOLS = ["tool_search"] as const;
