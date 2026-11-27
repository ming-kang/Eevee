import {
  arr,
  bool,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  type Static,
  str,
} from "@earendil-works/pi-schema";

export const SkillTriggerModeSchema = oneOf(["model", "user", "disabled"]);
export type SkillTriggerMode = Static<typeof SkillTriggerModeSchema>;

export const SkillPolicyMapSchema = map(SkillTriggerModeSchema);
export type SkillPolicyMap = Static<typeof SkillPolicyMapSchema>;

export const SkillDiagnosticSchema = obj({
  type: oneOf(["warning", "collision", "error"]),
  message: str(),
  path: str(),
  skillName: opt(str()),
});
export type SkillDiagnostic = Static<typeof SkillDiagnosticSchema>;

export const SkillEntrySchema = obj({
  name: str(),
  description: str(),
  path: str(),
  baseDir: str(),
  source: oneOf(["global", "workspace"]),
  workspace: opt(str()),
  disableModelInvocation: bool(),
  defaultMode: SkillTriggerModeSchema,
  effectiveMode: SkillTriggerModeSchema,
  globalOverride: opt(SkillTriggerModeSchema),
  projectOverride: opt(SkillTriggerModeSchema),
});
export type SkillEntry = Static<typeof SkillEntrySchema>;

export const SkillsListResponseSchema = obj({
  skills: arr(SkillEntrySchema),
  diagnostics: arr(SkillDiagnosticSchema),
  globalPolicy: SkillPolicyMapSchema,
  projectPolicy: opt(SkillPolicyMapSchema),
});
export type SkillsListResponse = Static<typeof SkillsListResponseSchema>;

export const PutSkillsPolicyRequestSchema = obj({ policy: nullable(SkillPolicyMapSchema) });
export type PutSkillsPolicyRequest = Static<typeof PutSkillsPolicyRequestSchema>;
