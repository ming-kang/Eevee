export const CONTEXT_FILE = "AGENTS.md";
export const SKILL_FILE = "SKILL.md";

export type PromptContextOptions = {
  readonly globalDir?: string;
  readonly workspaces?: readonly string[];
};
