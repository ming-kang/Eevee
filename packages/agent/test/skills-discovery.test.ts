import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverContext,
  discoverSkills,
  discoverSkillsWithDiagnostics,
  parseSkillFrontmatter,
  stripSkillFrontmatter,
} from "../src/context/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-skills-discovery-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("discoverSkillsWithDiagnostics scans only userHomeDir/.agents/skills and workspace .agents/skills", async () => {
  await withTempDir(async (dir) => {
    const userHomeDir = join(dir, "home");
    const globalDir = join(dir, "eevee-global");
    const workspace = join(dir, "ws");

    await mkdir(join(userHomeDir, ".agents", "skills", "home-skill"), { recursive: true });
    await mkdir(join(globalDir, "skills", "ignored-global-skills"), { recursive: true });
    await mkdir(join(globalDir, ".agents", "skills", "ignored-global-agents"), { recursive: true });
    await mkdir(join(workspace, ".pi", "skills", "ignored-pi"), { recursive: true });
    await mkdir(join(workspace, ".agents", "skills", "ws-skill"), { recursive: true });

    await writeFile(
      join(userHomeDir, ".agents", "skills", "home-skill", "SKILL.md"),
      "---\nname: home-skill\ndescription: Global home skill\n---\nbody\n",
    );
    await writeFile(
      join(globalDir, "skills", "ignored-global-skills", "SKILL.md"),
      "---\nname: ignored-global-skills\ndescription: Should not be scanned\n---\n",
    );
    await writeFile(
      join(globalDir, ".agents", "skills", "ignored-global-agents", "SKILL.md"),
      "---\nname: ignored-global-agents\ndescription: Should not be scanned\n---\n",
    );
    await writeFile(
      join(workspace, ".pi", "skills", "ignored-pi", "SKILL.md"),
      "---\nname: ignored-pi\ndescription: Should not be scanned\n---\n",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "ws-skill", "SKILL.md"),
      "---\nname: ws-skill\ndescription: Workspace skill\n---\nbody\n",
    );

    const { skills, diagnostics } = await discoverSkillsWithDiagnostics({
      globalDir,
      userHomeDir,
      workspaces: [workspace],
    });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      skills.map((skill) => ({
        name: skill.name,
        source: skill.source,
        baseDir: skill.baseDir,
        workspace: skill.workspace,
      })),
      [
        {
          name: "ws-skill",
          source: "workspace",
          baseDir: join(workspace, ".agents", "skills", "ws-skill"),
          workspace,
        },
        {
          name: "home-skill",
          source: "global",
          baseDir: join(userHomeDir, ".agents", "skills", "home-skill"),
          workspace: undefined,
        },
      ],
    );

    const disabledGlobal = await discoverSkills({
      globalDir,
      userHomeDir: null,
      workspaces: [workspace],
    });
    assert.deepEqual(
      disabledGlobal.map((skill) => skill.name),
      ["ws-skill"],
    );
  });
});

test("discoverSkillsWithDiagnostics walks ancestors up to git repo root and categorizes $HOME separately", async () => {
  await withTempDir(async (dir) => {
    const gitCase = join(dir, "git-case");
    const outside = join(gitCase, ".agents", "skills", "outside-repo");
    const repo = join(gitCase, "repo");
    const nested = join(repo, "apps", "web");
    await mkdir(outside, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(repo, ".agents", "skills", "repo-skill"), { recursive: true });
    await mkdir(join(nested, ".agents", "skills", "app-skill"), { recursive: true });

    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: outside-repo\ndescription: Above git root\n---\n",
    );
    await writeFile(
      join(repo, ".agents", "skills", "repo-skill", "SKILL.md"),
      "---\nname: repo-skill\ndescription: At git root\n---\n",
    );
    await writeFile(
      join(nested, ".agents", "skills", "app-skill", "SKILL.md"),
      "---\nname: app-skill\ndescription: At nested workspace\n---\n",
    );

    const repoSkills = await discoverSkills({ userHomeDir: null, workspaces: [nested] });
    assert.deepEqual(
      repoSkills.map((skill) => skill.name),
      ["app-skill", "repo-skill"],
    );

    const homeDir = join(dir, "home-case", "user-home");
    const nonGitWs = join(homeDir, "scratch");
    await mkdir(join(homeDir, ".agents", "skills", "global-helper"), { recursive: true });
    await mkdir(join(nonGitWs, ".agents", "skills", "local-helper"), { recursive: true });
    await writeFile(
      join(homeDir, ".agents", "skills", "global-helper", "SKILL.md"),
      "---\nname: global-helper\ndescription: Global under home\n---\n",
    );
    await writeFile(
      join(nonGitWs, ".agents", "skills", "local-helper", "SKILL.md"),
      "---\nname: local-helper\ndescription: Local non-git\n---\n",
    );

    const nonGitSkills = await discoverSkills({ userHomeDir: homeDir, workspaces: [nonGitWs] });
    assert.deepEqual(
      nonGitSkills.map((skill) => ({ name: skill.name, source: skill.source })),
      [
        { name: "local-helper", source: "workspace" },
        { name: "global-helper", source: "global" },
      ],
    );
  });
});

test("discoverSkillsWithDiagnostics handles recursive layout, ignore files, hidden dirs, node_modules, and symlinks", async () => {
  await withTempDir(async (dir) => {
    const skillsRoot = join(dir, ".agents", "skills");
    await mkdir(skillsRoot, { recursive: true });

    await writeFile(
      join(skillsRoot, "root-skill.md"),
      "---\ndescription: Direct root markdown skill\n---\nroot body\n",
    );
    await writeFile(
      join(skillsRoot, ".gitignore"),
      "gitignored/\n*.draft.md\nnegated/*.md\n!negated/kept.md\n",
    );
    await writeFile(join(skillsRoot, ".ignore"), "ignored-by-ignore/\n");
    await writeFile(join(skillsRoot, ".fdignore"), "ignored-by-fd/\n");
    await writeFile(
      join(skillsRoot, "wip.draft.md"),
      "---\nname: wip-draft\ndescription: Should be ignored\n---\n",
    );

    await mkdir(join(skillsRoot, "category", "nested-skill", "references", "sub"), {
      recursive: true,
    });
    await writeFile(
      join(skillsRoot, "category", "README.md"),
      "---\nname: category-readme\ndescription: Non-root md must be ignored\n---\n",
    );
    await writeFile(
      join(skillsRoot, "category", "nested-skill", "SKILL.md"),
      "---\nname: nested-skill\ndescription: Nested skill root\n---\n",
    );
    await writeFile(
      join(skillsRoot, "category", "nested-skill", "references", "sub", "SKILL.md"),
      "---\nname: unreachable-child\ndescription: Must not recurse past SKILL.md\n---\n",
    );

    await mkdir(join(skillsRoot, ".hidden-dir", "secret"), { recursive: true });
    await writeFile(
      join(skillsRoot, ".hidden-dir", "secret", "SKILL.md"),
      "---\nname: hidden-skill\ndescription: Hidden dir must be skipped\n---\n",
    );

    await mkdir(join(skillsRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(skillsRoot, "node_modules", "pkg", "SKILL.md"),
      "---\nname: nm-skill\ndescription: node_modules must be skipped\n---\n",
    );

    await mkdir(join(skillsRoot, "gitignored", "s"), { recursive: true });
    await writeFile(
      join(skillsRoot, "gitignored", "s", "SKILL.md"),
      "---\nname: gitignored-skill\ndescription: gitignored\n---\n",
    );

    await mkdir(join(skillsRoot, "ignored-by-ignore", "s"), { recursive: true });
    await writeFile(
      join(skillsRoot, "ignored-by-ignore", "s", "SKILL.md"),
      "---\nname: dotignore-skill\ndescription: dotignore\n---\n",
    );

    await mkdir(join(skillsRoot, "ignored-by-fd", "s"), { recursive: true });
    await writeFile(
      join(skillsRoot, "ignored-by-fd", "s", "SKILL.md"),
      "---\nname: fdignore-skill\ndescription: fdignore\n---\n",
    );

    await mkdir(join(skillsRoot, "negated", "kept"), { recursive: true });
    await writeFile(
      join(skillsRoot, "negated", "kept", "SKILL.md"),
      "---\nname: kept\ndescription: Negated sub-rule still recurses\n---\n",
    );

    const externalSkill = join(dir, "external-skill");
    await mkdir(externalSkill, { recursive: true });
    await writeFile(
      join(externalSkill, "SKILL.md"),
      "---\nname: linked-skill\ndescription: Loaded via symlink\n---\n",
    );
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(externalSkill, join(skillsRoot, "linked-skill"), linkType);
    await symlink(externalSkill, join(skillsRoot, "linked-skill-dup"), linkType);
    await symlink(skillsRoot, join(skillsRoot, "category", "cycle"), linkType);

    const { skills, diagnostics } = await discoverSkillsWithDiagnostics({
      userHomeDir: null,
      workspaces: [dir],
    });
    assert.deepEqual(diagnostics, []);
    const names = skills.map((skill) => skill.name).sort();
    assert.deepEqual(names, ["kept", "linked-skill", "nested-skill", "root-skill"]);
  });
});

test("discoverSkillsWithDiagnostics resolves collisions by priority and emits collision diagnostics", async () => {
  await withTempDir(async (dir) => {
    const userHomeDir = join(dir, "home");
    const repo = join(dir, "repo");
    const nested = join(repo, "sub");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");

    const nestedSkillPath = join(nested, ".agents", "skills", "shared", "SKILL.md");
    const repoSkillPath = join(repo, ".agents", "skills", "shared", "SKILL.md");
    const globalSkillPath = join(userHomeDir, ".agents", "skills", "shared", "SKILL.md");

    await mkdir(join(nested, ".agents", "skills", "shared"), { recursive: true });
    await mkdir(join(repo, ".agents", "skills", "shared"), { recursive: true });
    await mkdir(join(userHomeDir, ".agents", "skills", "shared"), { recursive: true });

    await writeFile(nestedSkillPath, "---\nname: shared\ndescription: nested wins\n---\n");
    await writeFile(repoSkillPath, "---\nname: shared\ndescription: outer repo\n---\n");
    await writeFile(globalSkillPath, "---\nname: shared\ndescription: global\n---\n");

    const context = await discoverContext({ userHomeDir, workspaces: [nested] });
    assert.equal(context.skills.length, 1);
    assert.equal(context.skills[0]?.description, "nested wins");
    assert.equal(context.skills[0]?.source, "workspace");

    assert.equal(context.skillDiagnostics.length, 2);
    assert.ok(context.skillDiagnostics.every((d) => d.type === "collision"));
    assert.equal(context.skillDiagnostics[0]?.path, repoSkillPath);
    assert.ok(context.skillDiagnostics[0]?.message.includes(nestedSkillPath));
    assert.ok(context.skillDiagnostics[0]?.message.includes(repoSkillPath));
    assert.equal(context.skillDiagnostics[1]?.path, globalSkillPath);
    assert.ok(context.skillDiagnostics[1]?.message.includes(nestedSkillPath));
    assert.ok(context.skillDiagnostics[1]?.message.includes(globalSkillPath));
  });
});

test("full YAML frontmatter parsing, stripSkillFrontmatter, and validation diagnostics", async () => {
  const folded =
    "\uFEFF---\r\nname: pdf-tool\r\ndescription: >\r\n  Extract tables and\r\n  text from PDFs.\r\ndisable-model-invocation: true\r\n---\r\n\r\n# PDF Guide\r\nUse pdf.py.\r\n";
  assert.deepEqual(parseSkillFrontmatter(folded), {
    name: "pdf-tool",
    description: "Extract tables and text from PDFs.",
    disableModelInvocation: true,
  });
  assert.equal(stripSkillFrontmatter(folded).trim(), "# PDF Guide\nUse pdf.py.");

  const literal = '---\nname: "quoted-skill"\ndescription: |\n  Line one\n  Line two\n---\nBody\n';
  assert.deepEqual(parseSkillFrontmatter(literal), {
    name: "quoted-skill",
    description: "Line one\nLine two",
  });
  assert.equal(stripSkillFrontmatter("plain body"), "plain body");

  await withTempDir(async (dir) => {
    const root = join(dir, ".agents", "skills");
    await mkdir(join(root, "missing-desc"), { recursive: true });
    await mkdir(join(root, "bad-yaml"), { recursive: true });
    await mkdir(join(root, "long-desc"), { recursive: true });
    await mkdir(join(root, "Bad--Name_1"), { recursive: true });
    await mkdir(join(root, "-edge-"), { recursive: true });
    await mkdir(join(root, "a".repeat(65)), { recursive: true });

    await writeFile(join(root, "missing-desc", "SKILL.md"), "---\nname: missing-desc\n---\nbody\n");
    await writeFile(
      join(root, "bad-yaml", "SKILL.md"),
      "---\nname: bad-yaml\ndescription: [unclosed\n---\nbody\n",
    );
    await writeFile(
      join(root, "long-desc", "SKILL.md"),
      `---\nname: long-desc\ndescription: ${"x".repeat(1025)}\n---\nbody\n`,
    );
    await writeFile(
      join(root, "Bad--Name_1", "SKILL.md"),
      "---\ndescription: Fallback to invalid directory name\n---\n",
    );
    await writeFile(
      join(root, "-edge-", "SKILL.md"),
      "---\nname: -edge-\ndescription: Leading and trailing hyphens\n---\n",
    );
    await writeFile(
      join(root, "a".repeat(65), "SKILL.md"),
      `---\nname: ${"a".repeat(65)}\ndescription: Too long name\n---\n`,
    );

    const { skills, diagnostics } = await discoverSkillsWithDiagnostics({
      userHomeDir: null,
      workspaces: [dir],
    });

    assert.equal(
      skills.some((skill) => skill.name === "missing-desc" || skill.name === "bad-yaml"),
      false,
    );
    assert.ok(skills.some((skill) => skill.name === "long-desc"));
    assert.ok(skills.some((skill) => skill.name === "Bad--Name_1"));
    assert.ok(skills.some((skill) => skill.name === "-edge-"));
    assert.ok(skills.some((skill) => skill.name === "a".repeat(65)));

    const missingErr = diagnostics.find(
      (d) => d.type === "error" && d.path.endsWith(join("missing-desc", "SKILL.md")),
    );
    assert.equal(missingErr?.message, "description is required");

    const yamlErr = diagnostics.find(
      (d) => d.type === "error" && d.path.endsWith(join("bad-yaml", "SKILL.md")),
    );
    assert.ok(yamlErr);

    const longDescWarn = diagnostics.find(
      (d) => d.type === "warning" && d.skillName === "long-desc",
    );
    assert.ok(longDescWarn);

    const badNameWarnings = diagnostics.filter(
      (d) => d.type === "warning" && d.skillName === "Bad--Name_1",
    );
    assert.ok(badNameWarnings.length >= 2);

    assert.ok(diagnostics.some((d) => d.type === "warning" && d.skillName === "-edge-"));
    assert.ok(diagnostics.some((d) => d.type === "warning" && d.skillName === "a".repeat(65)));
  });
});
