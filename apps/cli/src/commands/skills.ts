import { connectLocalEngine } from "@eevee/engine";
import { parseWithSchema, type SkillTriggerMode, SkillTriggerModeSchema } from "@eevee/protocol";
import type { Command } from "commander";
import { parseProjectIdFlag } from "../args.ts";
import { formatSkillsList } from "../format.ts";

function parseNonEmptySkillName(raw: string): string {
  if (raw.trim().length === 0) {
    throw new Error("Invalid skillName: must not be empty");
  }
  return raw;
}

function parseSkillPolicyMode(raw: string): SkillTriggerMode | "reset" {
  if (raw === "reset") return "reset";
  try {
    return parseWithSchema(SkillTriggerModeSchema, raw, "mode");
  } catch {
    throw new Error(`Invalid mode "${raw}": expected model, user, disabled, or reset`);
  }
}

export function registerSkillsCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const skillsCommand = program
    .command("skills")
    .description("Inspect and manage discovered skills and trigger policies");

  skillsCommand
    .command("list")
    .description("List discovered skills, trigger modes, and diagnostics")
    .option("--project <projectId>", "Include workspace skills and project-level overrides")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      const response =
        projectId === undefined
          ? await client.listSkills()
          : await client.listProjectSkills(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatSkillsList(response));
    });

  skillsCommand
    .command("set-policy")
    .description("Set or reset the trigger mode policy for a skill")
    .argument("<skillName>", "Skill name")
    .argument("<mode>", "Trigger mode: model, user, disabled, or reset")
    .option("--project <projectId>", "Apply override to a specific project")
    .option("--json", "Output JSON")
    .action(
      async (
        rawSkillName: string,
        rawMode: string,
        options: { project?: string; json?: boolean },
      ) => {
        const skillName = parseNonEmptySkillName(rawSkillName);
        const mode = parseSkillPolicyMode(rawMode);
        const projectId = parseProjectIdFlag(options.project);

        const { client } = await connectLocalEngine(env);
        const current =
          projectId === undefined
            ? await client.listSkills()
            : await client.listProjectSkills(projectId);
        const nextPolicy: Record<string, SkillTriggerMode> = {
          ...(projectId === undefined ? current.globalPolicy : (current.projectPolicy ?? {})),
        };

        if (mode === "reset") {
          delete nextPolicy[skillName];
        } else {
          nextPolicy[skillName] = mode;
        }

        const policy = Object.keys(nextPolicy).length === 0 ? null : nextPolicy;
        const updated =
          projectId === undefined
            ? await client.putSkillsPolicy({ policy })
            : await client.putProjectSkillsPolicy(projectId, { policy });
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        console.log(formatSkillsList(updated));
      },
    );

  skillsCommand
    .command("clear-policy")
    .description("Clear all global or project-level skill policy overrides")
    .option("--project <projectId>", "Clear policy overrides for a specific project")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      const updated =
        projectId === undefined
          ? await client.putSkillsPolicy({ policy: null })
          : await client.putProjectSkillsPolicy(projectId, { policy: null });
      if (options.json) {
        console.log(JSON.stringify(updated, null, 2));
        return;
      }
      console.log(formatSkillsList(updated));
    });
}
