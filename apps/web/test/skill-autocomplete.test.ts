import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillEntry } from "@eevee/protocol";
import { filterAutocompleteSkills, findCodeRanges } from "../src/lib/skill-autocomplete.ts";

function makeSkill(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: `${name} description`,
    path: `/repo/.agents/skills/${name}/SKILL.md`,
    baseDir: `/repo/.agents/skills/${name}`,
    source: "workspace",
    disableModelInvocation: false,
    defaultMode: "model",
    effectiveMode: "model",
    ...overrides,
  };
}

test("findCodeRanges finds inline spans and backtick or tilde fences, including unclosed fences", () => {
  const ranges = (text: string) =>
    findCodeRanges(text).map((range) => text.slice(range.start, range.end));
  assert.deepEqual(ranges("run `/skill:pdf` now"), ["`/skill:pdf`"]);
  assert.deepEqual(ranges("```\n/skill:pdf\n```\nafter"), ["```\n/skill:pdf\n```\n"]);
  assert.deepEqual(ranges("~~~\n/skill:pdf\n~~~"), ["~~~\n/skill:pdf\n~~~"]);
  assert.deepEqual(ranges("```\n/skill dep"), ["```\n/skill dep"]);
  assert.deepEqual(ranges("`/skill:old` /skill:new"), ["`/skill:old`"]);
  assert.deepEqual(ranges("unclosed `/skill:pdf"), []);
});

test("filterAutocompleteSkills excludes disabled skills and ranks prefix > name > description", () => {
  const skills: SkillEntry[] = [
    makeSkill("run-deploy", { description: "Deploy to staging" }),
    makeSkill("deploy", { effectiveMode: "user", source: "global" }),
    makeSkill("release", { description: "Automate deploy pipelines" }),
    makeSkill("disabled-deploy", { effectiveMode: "disabled" }),
  ];

  const all = filterAutocompleteSkills(skills, "");
  assert.deepEqual(
    all.map((s) => s.name),
    ["run-deploy", "deploy", "release"],
  );

  const matched = filterAutocompleteSkills(skills, "deploy");
  assert.deepEqual(
    matched.map((s) => s.name),
    ["deploy", "run-deploy", "release"],
  );
});
