import { parseWithSchema, type SkillTriggerMode, SkillTriggerModeSchema } from "@eevee/protocol";
import type { Command } from "commander";
import { parseNonEmpty, parseProjectIdFlag } from "../args.ts";
import { runEngineCommand } from "../command-helpers.ts";
import { formatSkillsList } from "../format.ts";

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
      await runEngineCommand(
        env,
        options,
        (client) => client.skills(projectId).list(),
        formatSkillsList,
      );
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
        const skillName = parseNonEmpty(rawSkillName, "skillName");
        const mode = parseSkillPolicyMode(rawMode);
        const projectId = parseProjectIdFlag(options.project);

        await runEngineCommand(
          env,
          options,
          async (client) => {
            const skills = client.skills(projectId);
            const current = await skills.list();
            const nextPolicy: Record<string, SkillTriggerMode> = {
              ...(projectId === undefined ? current.globalPolicy : (current.projectPolicy ?? {})),
            };
            if (mode === "reset") {
              delete nextPolicy[skillName];
            } else {
              nextPolicy[skillName] = mode;
            }
            const policy = Object.keys(nextPolicy).length === 0 ? null : nextPolicy;
            return skills.putPolicy({ policy });
          },
          formatSkillsList,
        );
      },
    );

  skillsCommand
    .command("clear-policy")
    .description("Clear all global or project-level skill policy overrides")
    .option("--project <projectId>", "Clear policy overrides for a specific project")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      const projectId = parseProjectIdFlag(options.project);
      await runEngineCommand(
        env,
        options,
        (client) => client.skills(projectId).putPolicy({ policy: null }),
        formatSkillsList,
      );
    });
}
