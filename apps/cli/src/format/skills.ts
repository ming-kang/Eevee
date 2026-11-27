import type { SkillEntry, SkillsListResponse } from "@eevee/protocol";
import { tabular } from "./settings.ts";

function formatSkillMode(skill: SkillEntry): string {
  if (skill.projectOverride !== undefined) {
    const globalNote = skill.globalOverride === undefined ? "" : `, global=${skill.globalOverride}`;
    return `mode=${skill.effectiveMode} (project override, default=${skill.defaultMode}${globalNote})`;
  }
  if (skill.globalOverride !== undefined) {
    return `mode=${skill.effectiveMode} (global override, default=${skill.defaultMode})`;
  }
  return `mode=${skill.effectiveMode}`;
}

export function formatSkillsList(response: SkillsListResponse): string {
  const lines =
    response.skills.length === 0
      ? ["No skills discovered."]
      : [
          tabular(
            response.skills.map((skill) => [
              skill.name,
              skill.source,
              formatSkillMode(skill),
              skill.description.replace(/\r?\n/g, " "),
              skill.path,
            ]),
          ),
        ];
  if (response.diagnostics.length > 0) {
    lines.push("", "Skill diagnostics:");
    for (const diagnostic of response.diagnostics) {
      const skillLabel = diagnostic.skillName === undefined ? "" : ` (${diagnostic.skillName})`;
      lines.push(`- [${diagnostic.type}]${skillLabel} ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
}
