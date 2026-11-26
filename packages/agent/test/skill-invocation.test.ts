import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBaseExtension,
  discoverSkills,
  expandSkillReferences,
  resolveSkillTriggerMode,
  type SkillInfo,
  type SkillPolicyMap,
} from "../src/context/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-skill-invocation-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function promptInput(cwd: string, tools: readonly string[] = ["read"]) {
  return {
    conversationId: 1,
    agent: {
      tools: tools.map((name) => ({ name })),
      thinkingLevel: "off",
      extensions: [],
      callable: [],
      deferred: [],
      sections: [],
      cwd,
    },
    env: undefined,
    shown: {},
    read: {},
  } as never;
}

function skillsSection(extension: ReturnType<typeof createBaseExtension>) {
  const found = (extension.sections ?? []).find((entry) => entry.key === "skills");
  assert.ok(found, "expected skills section");
  return found;
}

test("resolveSkillTriggerMode and base-extension <available_skills> apply 3-mode policy", async () => {
  await withTempDir(async (dir) => {
    const skillsRoot = join(dir, ".agents", "skills");
    await mkdir(join(skillsRoot, "model-default"), { recursive: true });
    await mkdir(join(skillsRoot, "user-default"), { recursive: true });
    await mkdir(join(skillsRoot, "to-disable"), { recursive: true });

    await writeFile(
      join(skillsRoot, "model-default", "SKILL.md"),
      "---\nname: model-default\ndescription: Default model skill\n---\nbody\n",
    );
    await writeFile(
      join(skillsRoot, "user-default", "SKILL.md"),
      "---\nname: user-default\ndescription: Default user-only skill\ndisable-model-invocation: true\n---\nbody\n",
    );
    await writeFile(
      join(skillsRoot, "to-disable", "SKILL.md"),
      "---\nname: to-disable\ndescription: Will be disabled by policy\n---\nbody\n",
    );

    const skills = await discoverSkills({ userHomeDir: null, workspaces: [dir] });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    const modelSkill = byName.get("model-default");
    const userSkill = byName.get("user-default");
    const disabledSkill = byName.get("to-disable");
    assert.ok(modelSkill && userSkill && disabledSkill);

    assert.equal(resolveSkillTriggerMode(modelSkill), "model");
    assert.equal(resolveSkillTriggerMode(userSkill), "user");

    let policy: SkillPolicyMap | undefined = {
      "user-default": "model",
      "model-default": "user",
      "to-disable": "disabled",
    };

    assert.equal(resolveSkillTriggerMode(userSkill, policy), "model");
    assert.equal(resolveSkillTriggerMode(modelSkill, policy), "user");
    assert.equal(resolveSkillTriggerMode(disabledSkill, policy), "disabled");

    const extension = createBaseExtension({
      userHomeDir: null,
      workspaces: [dir],
      skillPolicy: () => policy,
    });
    const section = skillsSection(extension);

    const rendered1 = await section.render(promptInput(dir), {} as never);
    assert.ok(rendered1?.includes("<name>user-default</name>"));
    assert.equal(rendered1?.includes("<name>model-default</name>"), false);
    assert.equal(rendered1?.includes("<name>to-disable</name>"), false);

    policy = { "model-default": "model", "user-default": "disabled" };
    const rendered2 = await section.render(promptInput(dir), {} as never);
    assert.ok(rendered2?.includes("<name>model-default</name>"));
    assert.ok(rendered2?.includes("<name>to-disable</name>"));
    assert.equal(rendered2?.includes("<name>user-default</name>"), false);
  });
});

test("expandSkillReferences handles leading prefixes, multiple skills, prose, code spans, boundaries, and blocked skills", async () => {
  await withTempDir(async (dir) => {
    const skillsRoot = join(dir, ".agents", "skills");
    await mkdir(join(skillsRoot, "pdf"), { recursive: true });
    await mkdir(join(skillsRoot, "pdf-extract"), { recursive: true });
    await mkdir(join(skillsRoot, "manual"), { recursive: true });
    await mkdir(join(skillsRoot, "blocked"), { recursive: true });

    const pdfPath = join(skillsRoot, "pdf", "SKILL.md");
    const pdfBaseDir = join(skillsRoot, "pdf");
    const pdfExtractPath = join(skillsRoot, "pdf-extract", "SKILL.md");
    const manualPath = join(skillsRoot, "manual", "SKILL.md");

    await writeFile(
      pdfPath,
      "---\nname: pdf\ndescription: PDF basics\n---\n\n# PDF\nRun scripts/parse.py\n",
    );
    await writeFile(
      pdfExtractPath,
      "---\nname: pdf-extract\ndescription: Extract PDF tables\n---\nUse table mode.\n",
    );
    await writeFile(
      manualPath,
      "---\nname: manual\ndescription: Manual only\ndisable-model-invocation: true\n---\nManual steps.\n",
    );
    await writeFile(
      join(skillsRoot, "blocked", "SKILL.md"),
      "---\nname: blocked\ndescription: Disabled skill\n---\nShould never appear.\n",
    );

    const skills = await discoverSkills({ userHomeDir: null, workspaces: [dir] });
    const policy: SkillPolicyMap = { blocked: "disabled" };

    // Leading single skill with args
    const leading = await expandSkillReferences("/skill:pdf extract page 1", skills, { policy });
    assert.equal(
      leading.text,
      `<skill name="pdf" location="${pdfPath}">\nReferences are relative to ${pdfBaseDir}.\n\n# PDF\nRun scripts/parse.py\n</skill>\n\nextract page 1`,
    );
    assert.deepEqual(leading.invoked, [{ name: "pdf", path: pdfPath, mode: "model" }]);
    assert.deepEqual(leading.blocked, []);
    assert.deepEqual(leading.errors, []);

    // Leading skill with no args
    const solo = await expandSkillReferences("/skill:pdf", skills, { policy });
    assert.equal(
      solo.text,
      `<skill name="pdf" location="${pdfPath}">\nReferences are relative to ${pdfBaseDir}.\n\n# PDF\nRun scripts/parse.py\n</skill>`,
    );

    // Multi-skill contiguous leading prefix + longest name match ("pdf-extract" beats "pdf")
    const multiLead = await expandSkillReferences(
      "/skill:pdf-extract /skill:manual inspect doc",
      skills,
      { policy },
    );
    assert.deepEqual(multiLead.invoked, [
      { name: "pdf-extract", path: pdfExtractPath, mode: "model" },
      { name: "manual", path: manualPath, mode: "user" },
    ]);
    assert.ok(multiLead.text.startsWith('<skill name="pdf-extract"'));
    assert.ok(multiLead.text.includes('<skill name="manual"'));
    assert.ok(multiLead.text.endsWith("</skill>\n\ninspect doc"));
    assert.equal(multiLead.text.includes("/skill:"), false);

    // Embedded in prose: full prose preserved intact below <skill> blocks
    const prose = await expandSkillReferences(
      "Please run /skill:pdf and then /skill:manual carefully.",
      skills,
      { policy },
    );
    assert.deepEqual(
      prose.invoked.map((item) => item.name),
      ["pdf", "manual"],
    );
    assert.ok(
      prose.text.endsWith("</skill>\n\nPlease run /skill:pdf and then /skill:manual carefully."),
    );

    // Non-contiguous leading + middle stays intact
    const mixedProse = await expandSkillReferences(
      "/skill:pdf and then /skill:manual finish",
      skills,
      { policy },
    );
    assert.ok(mixedProse.text.endsWith("</skill>\n\n/skill:pdf and then /skill:manual finish"));

    // Skips inline code spans and fenced code blocks (backtick & tilde)
    const codeOnly = await expandSkillReferences(
      [
        "Literal `/skill:pdf` in inline code.",
        "Double ``/skill:manual`` in inline code.",
        "```md",
        "/skill:pdf",
        "```",
        "~~~",
        "/skill:manual",
        "~~~",
      ].join("\n"),
      skills,
      { policy },
    );
    assert.deepEqual(codeOnly.invoked, []);
    assert.equal(codeOnly.text.includes("<skill "), false);

    // Expands outside code even when code spans are present
    const codePlusReal = await expandSkillReferences(
      "Ignore `/skill:manual` and run /skill:pdf on it.",
      skills,
      { policy },
    );
    assert.deepEqual(
      codePlusReal.invoked.map((item) => item.name),
      ["pdf"],
    );

    // Boundaries: rejects paths/unknown suffixes, accepts punctuation and CJK
    const nonBoundary = await expandSkillReferences(
      "Look at src/skill:pdf ./skill:pdf https://x.dev/skill:pdf /skill:pdf-other /skill:pdf2 /skill:pdf/sub",
      skills,
      { policy },
    );
    assert.deepEqual(nonBoundary.invoked, []);

    const cjkBoundary = await expandSkillReferences("请用/skill:pdf处理这个文件。", skills, {
      policy,
    });
    assert.deepEqual(
      cjkBoundary.invoked.map((item) => item.name),
      ["pdf"],
    );

    // Deduplicates repeated invocation in one message
    const repeated = await expandSkillReferences("/skill:pdf and /skill:pdf again", skills, {
      policy,
    });
    assert.equal(repeated.invoked.length, 1);
    assert.equal(repeated.text.split('<skill name="pdf"').length - 1, 1);

    // Disabled skill is blocked and not expanded
    const disabledOnly = await expandSkillReferences("/skill:blocked run now", skills, { policy });
    assert.deepEqual(disabledOnly.invoked, []);
    assert.deepEqual(disabledOnly.blocked, [
      { name: "blocked", reason: 'Skill "blocked" is disabled' },
    ]);
    assert.equal(disabledOnly.text, "/skill:blocked run now");

    // Mix of expanded + blocked keeps /skill:blocked in trailing text
    const mixedBlocked = await expandSkillReferences("/skill:pdf /skill:blocked run", skills, {
      policy,
    });
    assert.deepEqual(
      mixedBlocked.invoked.map((item) => item.name),
      ["pdf"],
    );
    assert.deepEqual(mixedBlocked.blocked, [
      { name: "blocked", reason: 'Skill "blocked" is disabled' },
    ]);
    assert.ok(mixedBlocked.text.endsWith("</skill>\n\n/skill:blocked run"));

    // Read errors are recorded without throwing
    const missingSkill: SkillInfo = {
      name: "ghost",
      description: "Missing on disk",
      path: join(dir, "missing", "SKILL.md"),
      baseDir: join(dir, "missing"),
      source: "workspace",
      disableModelInvocation: false,
    };
    const readErr = await expandSkillReferences("/skill:ghost", [missingSkill]);
    assert.deepEqual(readErr.invoked, []);
    assert.equal(readErr.errors.length, 1);
    assert.equal(readErr.errors[0]?.name, "ghost");
  });
});
