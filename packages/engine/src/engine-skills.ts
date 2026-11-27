import {
  discoverSkillsWithDiagnostics,
  expandSkillReferences,
  resolveSkillTriggerMode,
} from "@eevee/agent";
import {
  type ProjectSummary,
  type PutSkillsPolicyRequest,
  PutSkillsPolicyRequestSchema,
  parseWithSchema,
  type SkillEntry,
  type SkillsListResponse,
} from "@eevee/protocol";
import {
  effectiveSkillsPolicy,
  KV_SKILLS_POLICY,
  readGlobalSkillsPolicy,
} from "./engine-config.ts";
import { EngineError, guardAsync } from "./engine-error.ts";
import type { EngineStore } from "./store.ts";

export type SkillsDeps = {
  readonly store: EngineStore;
  readonly userHomeDir?: string | null;
  readonly requireProject: (projectId: string) => ProjectSummary;
};

export type SkillsHandle = {
  list(projectId?: string): Promise<SkillsListResponse>;
  putPolicy(input: PutSkillsPolicyRequest, projectId?: string): Promise<SkillsListResponse>;
};

export function createSkillsHandle(
  deps: SkillsDeps & { readonly assertOpen: () => void },
): SkillsHandle {
  return {
    list: guardAsync(deps.assertOpen, (projectId) => listSkills(deps, projectId)),
    putPolicy: guardAsync(deps.assertOpen, (input, projectId) =>
      projectId === undefined
        ? putGlobalSkillsPolicy(deps, input)
        : putProjectSkillsPolicy(deps, projectId, input),
    ),
  };
}

export async function listSkills(
  deps: SkillsDeps,
  projectId?: string,
): Promise<SkillsListResponse> {
  const project = projectId === undefined ? undefined : deps.requireProject(projectId);
  const { skills, diagnostics } = await discoverSkillsWithDiagnostics({
    ...(project === undefined ? {} : { workspaces: project.workspaces }),
    ...(deps.userHomeDir === undefined ? {} : { userHomeDir: deps.userHomeDir }),
  });

  const globalPolicy = readGlobalSkillsPolicy(deps.store);
  const projectPolicy =
    projectId === undefined ? undefined : deps.store.getProjectSkillsPolicy(projectId);
  const effectivePolicy =
    projectId === undefined ? globalPolicy : effectiveSkillsPolicy(deps.store, projectId);

  const entries: SkillEntry[] = skills.map((skill) => {
    const defaultMode = resolveSkillTriggerMode(skill);
    const effectiveMode = resolveSkillTriggerMode(skill, effectivePolicy);
    const globalOverride = Object.hasOwn(globalPolicy, skill.name)
      ? globalPolicy[skill.name]
      : undefined;
    const projectOverride =
      projectPolicy !== undefined && Object.hasOwn(projectPolicy, skill.name)
        ? projectPolicy[skill.name]
        : undefined;
    return {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      baseDir: skill.baseDir,
      source: skill.source,
      ...(skill.workspace === undefined ? {} : { workspace: skill.workspace }),
      disableModelInvocation: skill.disableModelInvocation,
      defaultMode,
      effectiveMode,
      ...(globalOverride === undefined ? {} : { globalOverride }),
      ...(projectOverride === undefined ? {} : { projectOverride }),
    };
  });

  return {
    skills: entries,
    diagnostics: diagnostics.map((item) => ({
      type: item.type,
      message: item.message,
      path: item.path,
      ...(item.skillName === undefined ? {} : { skillName: item.skillName }),
    })),
    globalPolicy,
    ...(projectPolicy === undefined ? {} : { projectPolicy }),
  };
}

export async function putGlobalSkillsPolicy(
  deps: SkillsDeps,
  input: PutSkillsPolicyRequest,
): Promise<SkillsListResponse> {
  const validated = parseWithSchema(PutSkillsPolicyRequestSchema, input, "PutSkillsPolicyRequest");
  if (validated.policy === null || Object.keys(validated.policy).length === 0) {
    deps.store.deleteKv(KV_SKILLS_POLICY);
  } else {
    deps.store.setKv(KV_SKILLS_POLICY, { ...validated.policy });
  }
  return listSkills(deps);
}

export async function putProjectSkillsPolicy(
  deps: SkillsDeps,
  projectId: string,
  input: PutSkillsPolicyRequest,
): Promise<SkillsListResponse> {
  deps.requireProject(projectId);
  const validated = parseWithSchema(PutSkillsPolicyRequestSchema, input, "PutSkillsPolicyRequest");
  deps.store.setProjectSkillsPolicy(
    projectId,
    validated.policy === null ? null : { ...validated.policy },
  );
  return listSkills(deps, projectId);
}

export async function expandMessageSkills(
  deps: SkillsDeps,
  projectId: string,
  text: string,
): Promise<string> {
  if (!text.includes("/skill:")) return text;
  const project = deps.requireProject(projectId);
  const { skills } = await discoverSkillsWithDiagnostics({
    workspaces: project.workspaces,
    ...(deps.userHomeDir === undefined ? {} : { userHomeDir: deps.userHomeDir }),
  });
  const policy = effectiveSkillsPolicy(deps.store, projectId);
  const expanded = await expandSkillReferences(text, skills, { policy });
  if (expanded.blocked.length > 0) {
    const names = expanded.blocked.map((entry) => entry.name).join(", ");
    throw new EngineError(400, "skill_disabled", `Disabled skill(s): ${names}`);
  }
  return expanded.text;
}
