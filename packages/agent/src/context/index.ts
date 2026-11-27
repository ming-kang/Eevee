export {
  BASE_EXTENSION,
  type BaseExtensionOptions,
  createBaseExtension,
} from "./base-extension.ts";
export {
  AGENTS_SKILLS_DIR,
  CONTEXT_FILE,
  CONTEXT_FILENAMES,
  type ContextDiscovery,
  type ContextFile,
  discoverContext,
  discoverContextFiles,
  discoverSkills,
  discoverSkillsWithDiagnostics,
  type PromptContextOptions,
  parseSkillFrontmatter,
  resolveSkillTriggerMode,
  SKILL_FILE,
  type SkillDiagnostic,
  type SkillInfo,
  type SkillPolicyMap,
  type SkillTriggerMode,
  stripSkillFrontmatter,
} from "./discovery.ts";
export {
  type ExpandSkillsResult,
  expandSkillReferences,
  type InvokedSkill,
  type SkillInvocationResult,
} from "./skill-invocation.ts";
export {
  getToolPromptMeta,
  renderRulesSection,
  renderToolsSection,
  resolveToolPromptMeta,
  type ToolPromptMeta,
  withToolPromptMeta,
} from "./tool-meta.ts";
