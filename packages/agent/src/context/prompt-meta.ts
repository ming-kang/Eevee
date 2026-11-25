export type ToolGuideline = {
  readonly tool: string;
  readonly text: string;
};

const GUIDELINES: readonly ToolGuideline[] = [
  {
    tool: "read",
    text: "Use read to inspect files before changing them. Read with offset and limit for large files instead of loading them whole.",
  },
  {
    tool: "ls",
    text: "Use ls to orient in a directory before opening files; it shows sizes and entry kinds.",
  },
  {
    tool: "find",
    text: "Use find to locate files by name or glob pattern rather than walking directories one level at a time.",
  },
  {
    tool: "grep",
    text: "Use grep to search file contents with a regular expression before reading candidate files.",
  },
  {
    tool: "write",
    text: "Use write only for new files or complete rewrites. Prefer edit for changes to existing files.",
  },
  {
    tool: "edit",
    text: "Use edit for targeted changes. The old text must match exactly; include enough context to match once.",
  },
  {
    tool: "bash",
    text: "Use bash for builds, tests, and system commands. Quote paths with spaces. Prefer non-interactive commands; long-running work belongs in background tasks.",
  },
  {
    tool: "tasks",
    text: "Use tasks to list, read, or stop background work. Read output with head, tail, or a byte cursor instead of reloading whole logs.",
  },
];

export function guidelinesForTools(toolNames: readonly string[]): string | undefined {
  const offered = new Set(toolNames);
  const lines = GUIDELINES.filter((guideline) => offered.has(guideline.tool)).map(
    (guideline) => `- ${guideline.text}`,
  );
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
