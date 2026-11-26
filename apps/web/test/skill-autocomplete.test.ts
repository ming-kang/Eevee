import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillEntry } from "@eevee/protocol";
import {
  applySkillAutocomplete,
  extractSkillAutocompleteToken,
  filterAutocompleteSkills,
} from "../src/lib/skill-autocomplete.ts";

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

test("extractSkillAutocompleteToken handles /skill, /skill:query, /skill query and ignores code spans", () => {
  assert.deepEqual(extractSkillAutocompleteToken("/skill", 6), {
    query: "",
    start: 0,
    end: 6,
  });
  assert.deepEqual(extractSkillAutocompleteToken("please /skill", 13), {
    query: "",
    start: 7,
    end: 13,
  });
  assert.equal(extractSkillAutocompleteToken("/skills", 7), undefined);

  assert.deepEqual(extractSkillAutocompleteToken("/skill:", 7), {
    query: "",
    start: 0,
    end: 7,
  });
  assert.deepEqual(extractSkillAutocompleteToken("/skill:pd", 9), {
    query: "pd",
    start: 0,
    end: 9,
  });
  assert.deepEqual(extractSkillAutocompleteToken("请用/skill:pd处理", 11), {
    query: "pd",
    start: 2,
    end: 11,
  });
  assert.deepEqual(extractSkillAutocompleteToken("/skill:pdf-tools", 10), {
    query: "pdf",
    start: 0,
    end: 16,
  });

  assert.deepEqual(extractSkillAutocompleteToken("/skill ", 7), {
    query: "",
    start: 0,
    end: 7,
  });
  assert.deepEqual(extractSkillAutocompleteToken("/skill dep", 10), {
    query: "dep",
    start: 0,
    end: 10,
  });
  assert.equal(extractSkillAutocompleteToken("/skill dep more", 15), undefined);
  assert.equal(extractSkillAutocompleteToken("/skill:pdf more", 15), undefined);

  assert.equal(extractSkillAutocompleteToken("src/skill:pdf", 13), undefined);
  assert.equal(extractSkillAutocompleteToken("`/skill:pdf`", 10), undefined);
  assert.equal(extractSkillAutocompleteToken("`/skill`", 7), undefined);
  assert.equal(extractSkillAutocompleteToken("```\n/skill:pdf\n```", 13), undefined);
  assert.equal(extractSkillAutocompleteToken("```\n/skill dep", 14), undefined);
  assert.equal(extractSkillAutocompleteToken("~~~\n/skill:pdf\n~~~", 13), undefined);

  assert.deepEqual(extractSkillAutocompleteToken("`/skill:old` /skill:new", 23), {
    query: "new",
    start: 13,
    end: 23,
  });
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

test("applySkillAutocomplete replaces token span and avoids duplicating trailing space", () => {
  const token1 = extractSkillAutocompleteToken("run /skill:de", 13);
  assert.ok(token1);
  assert.deepEqual(applySkillAutocomplete("run /skill:de", token1, "deploy"), {
    nextText: "run /skill:deploy ",
    nextCursor: 18,
  });

  const token2 = extractSkillAutocompleteToken("/skill now", 6);
  assert.ok(token2);
  assert.deepEqual(applySkillAutocomplete("/skill now", token2, "deploy"), {
    nextText: "/skill:deploy now",
    nextCursor: 14,
  });

  const token3 = extractSkillAutocompleteToken("/skill dep", 10);
  assert.ok(token3);
  assert.deepEqual(applySkillAutocomplete("/skill dep", token3, "deploy"), {
    nextText: "/skill:deploy ",
    nextCursor: 14,
  });
});
