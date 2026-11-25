export {
  BASE_EXTENSION,
  type BaseExtensionOptions,
  createBaseExtension,
} from "./base-extension.ts";
export {
  AGENTS_SKILLS_DIR,
  CONTEXT_FILE,
  type ContextDiscovery,
  type ContextFile,
  discoverContext,
  discoverContextFiles,
  discoverSkills,
  PI_SKILLS_DIR,
  type PromptContextOptions,
  parseSkillFrontmatter,
  SKILL_FILE,
  SKILLS_DIR,
  type SkillInfo,
} from "./discovery.ts";
export { guidelinesForTools, type ToolGuideline } from "./prompt-meta.ts";
