import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBaseExtension,
  discoverContextFiles,
  discoverSkills,
  parseSkillFrontmatter,
  renderRulesSection,
  renderToolsSection,
  withToolPromptMeta,
} from "../src/context/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-context-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function promptInput(
  cwd: string | undefined,
  tools: readonly string[],
  callable: readonly string[] = [],
) {
  return {
    conversationId: 1,
    agent: {
      tools: tools.map((name) => ({ name })),
      thinkingLevel: "off",
      extensions: [],
      callable: callable.map((name) => ({ name })),
      deferred: [],
      sections: [],
      cwd,
    },
    env: undefined,
    shown: {},
    read: {},
  } as never;
}

function sectionByKey(extension: ReturnType<typeof createBaseExtension>, key: string) {
  const found = (extension.sections ?? []).find((entry) => entry.key === key);
  assert.ok(found, `expected section ${key}`);
  return found;
}

test("discoverContextFiles collects AGENTS.md from root down to the workspace", async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, "project", "nested");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "outer instructions");
    await writeFile(join(dir, "project", "AGENTS.md"), "inner instructions");
    const files = await discoverContextFiles({ workspaces: [workspace] });
    const contents = files.map((file) => file.content);
    assert.ok(contents.includes("outer instructions"));
    assert.ok(contents.includes("inner instructions"));
    assert.ok(contents.indexOf("outer instructions") < contents.indexOf("inner instructions"));
  });
});

test("discoverContextFiles includes the global AGENTS.md first and deduplicates", async () => {
  await withTempDir(async (dir) => {
    const globalDir = join(dir, "global");
    const workspace = join(dir, "ws");
    await mkdir(globalDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(globalDir, "AGENTS.md"), "global instructions");
    await writeFile(join(workspace, "AGENTS.md"), "workspace instructions");
    const files = await discoverContextFiles({ globalDir, workspaces: [workspace] });
    assert.deepEqual(
      files.map((file) => file.content),
      ["global instructions", "workspace instructions"],
    );
    const again = await discoverContextFiles({ globalDir: workspace, workspaces: [workspace] });
    assert.equal(again.length, 1);
  });
});

test("discoverContextFiles enforces per-directory precedence and strips UTF-8 BOM", async () => {
  await withTempDir(async (dir) => {
    const globalDir = join(dir, "global");
    const wsOverride = join(dir, "ws-override");
    const wsClaude = join(dir, "ws-claude");
    const wsBoth = join(dir, "ws-both");
    await mkdir(globalDir, { recursive: true });
    await mkdir(wsOverride, { recursive: true });
    await mkdir(wsClaude, { recursive: true });
    await mkdir(wsBoth, { recursive: true });

    await writeFile(join(globalDir, "CLAUDE.md"), "\uFEFFglobal claude");
    await writeFile(join(wsOverride, "AGENTS.override.md"), "\uFEFFoverride wins");
    await writeFile(join(wsOverride, "AGENTS.md"), "agents shadowed");
    await writeFile(join(wsOverride, "CLAUDE.md"), "claude shadowed");
    await writeFile(join(wsClaude, "CLAUDE.md"), "\uFEFFclaude only");
    await writeFile(join(wsBoth, "AGENTS.md"), "agents beats claude");
    await writeFile(join(wsBoth, "CLAUDE.md"), "claude ignored");

    const overrideFiles = await discoverContextFiles({ globalDir, workspaces: [wsOverride] });
    assert.deepEqual(
      overrideFiles.map((file) => file.content),
      ["global claude", "override wins"],
    );

    const claudeFiles = await discoverContextFiles({ workspaces: [wsClaude] });
    assert.deepEqual(
      claudeFiles.map((file) => file.content),
      ["claude only"],
    );

    const bothFiles = await discoverContextFiles({ workspaces: [wsBoth] });
    assert.deepEqual(
      bothFiles.map((file) => file.content),
      ["agents beats claude"],
    );
  });
});

test("discoverContextFiles deduplicates canonical symlink aliases", async () => {
  await withTempDir(async (dir) => {
    const realDir = join(dir, "real");
    const linkDir = join(dir, "link");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "AGENTS.md"), "shared canonical rules");
    await symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");

    const files = await discoverContextFiles({ globalDir: realDir, workspaces: [linkDir] });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.content, "shared canonical rules");
    assert.equal(files[0]?.workspace, undefined);

    const multiAlias = await discoverContextFiles({ workspaces: [realDir, linkDir] });
    assert.equal(multiAlias.length, 1);
    assert.equal(multiAlias[0]?.workspace, undefined);
  });
});

test("discoverContextFiles handles git linked worktree shadowing without spawning git", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "repo");
    const commonGit = join(repo, ".git");
    const worktreeGitDir = join(commonGit, "worktrees", "feat");
    const worktree = join(repo, ".worktrees", "feat");
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });

    await writeFile(join(commonGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feat\n");
    await writeFile(join(worktreeGitDir, "commondir"), "../..\n");
    await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    await writeFile(join(repo, "AGENTS.md"), "main repo context");
    await writeFile(join(worktree, "AGENTS.md"), "worktree context");

    const shadowed = await discoverContextFiles({ workspaces: [worktree] });
    assert.deepEqual(
      shadowed.map((file) => file.content),
      ["worktree context"],
    );

    await rm(join(worktree, "AGENTS.md"));
    const inherited = await discoverContextFiles({ workspaces: [worktree] });
    assert.deepEqual(
      inherited.map((file) => file.content),
      ["main repo context"],
    );

    const sibling = join(dir, "sibling-feat");
    const siblingGitDir = join(commonGit, "worktrees", "sibling");
    await mkdir(siblingGitDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(siblingGitDir, "HEAD"), "ref: refs/heads/sibling\n");
    await writeFile(join(siblingGitDir, "commondir"), "../..\n");
    await writeFile(join(sibling, ".git"), `gitdir: ${siblingGitDir}\n`);
    await writeFile(join(sibling, "AGENTS.md"), "sibling worktree context");

    const siblingFiles = await discoverContextFiles({ workspaces: [sibling] });
    assert.deepEqual(
      siblingFiles.map((file) => file.content),
      ["sibling worktree context"],
    );
  });
});

test("discoverContextFiles and agent-context attribute multiple workspaces cleanly", async () => {
  await withTempDir(async (dir) => {
    const globalDir = join(dir, "global");
    const wsA = join(dir, "mono", "pkg-a");
    const wsB = join(dir, "mono", "pkg-b");
    await mkdir(globalDir, { recursive: true });
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });

    await writeFile(join(globalDir, "AGENTS.md"), "global rules");
    await writeFile(join(dir, "mono", "AGENTS.md"), "shared monorepo rules");
    await writeFile(join(wsA, "AGENTS.md"), "rules for A");
    await writeFile(join(wsB, "CLAUDE.md"), "rules for B");

    const files = await discoverContextFiles({ globalDir, workspaces: [wsA, wsB] });
    assert.equal(files.length, 4);
    assert.equal(files[0]?.workspace, undefined);
    assert.equal(files[1]?.workspace, undefined);
    assert.equal(files[2]?.workspace, wsA);
    assert.equal(files[3]?.workspace, wsB);

    const ext = createBaseExtension({ globalDir, workspaces: [wsA, wsB] });
    const rendered = await sectionByKey(ext, "agent-context").render(
      promptInput(wsA, ["read"]),
      {} as never,
    );
    assert.ok(rendered?.includes(`<context-file path="${join(globalDir, "AGENTS.md")}">`));
    assert.ok(rendered?.includes(`<context-file path="${join(dir, "mono", "AGENTS.md")}">`));
    assert.ok(
      rendered?.includes(`<context-file path="${join(wsA, "AGENTS.md")}" workspace="${wsA}">`),
    );
    assert.ok(
      rendered?.includes(`<context-file path="${join(wsB, "CLAUDE.md")}" workspace="${wsB}">`),
    );
  });
});

test("parseSkillFrontmatter reads name, description, and disable-model-invocation", () => {
  assert.deepEqual(
    parseSkillFrontmatter(
      '---\nname: review\ndescription: "Reviews code"\ndisable-model-invocation: true\n---\nbody',
    ),
    { name: "review", description: "Reviews code", disableModelInvocation: true },
  );
  assert.deepEqual(parseSkillFrontmatter("no frontmatter"), {});
  assert.deepEqual(parseSkillFrontmatter("---\nname: x\n---\n"), { name: "x" });
});

test("discoverSkills scans global, .pi/skills, and .agents/skills with correct precedence", async () => {
  await withTempDir(async (dir) => {
    const globalDir = join(dir, "global");
    const workspace = join(dir, "ws", "nested");
    const root = join(dir, "ws");
    await mkdir(join(globalDir, "skills", "alpha"), { recursive: true });
    await mkdir(join(workspace, ".pi", "skills", "beta"), { recursive: true });
    await mkdir(join(root, ".agents", "skills", "gamma"), { recursive: true });
    await mkdir(join(root, ".agents", "skills", "alpha"), { recursive: true });
    await writeFile(
      join(globalDir, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: global alpha\n---\n",
    );
    await writeFile(join(workspace, ".pi", "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
    await writeFile(
      join(root, ".agents", "skills", "gamma", "SKILL.md"),
      "---\nname: gamma\n---\n",
    );
    await writeFile(
      join(root, ".agents", "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: workspace alpha\n---\n",
    );
    const skills = await discoverSkills({ globalDir, workspaces: [workspace] });
    const alpha = skills.find((skill) => skill.name === "alpha");
    assert.equal(alpha?.description, "global alpha");
    assert.ok(skills.some((skill) => skill.name === "beta" && skill.source === "workspace"));
    assert.ok(skills.some((skill) => skill.name === "gamma" && skill.source === "workspace"));
    const confined = await discoverSkills({ globalDir, workspaces: [join(dir, "isolated")] });
    assert.equal(
      confined.some((skill) => skill.name === "beta"),
      false,
    );
  });
});

test("renderToolsSection and renderRulesSection render metadata only for offered tools", () => {
  const read = withToolPromptMeta(
    { name: "read", description: "read", parameters: {}, execute: async () => ({}) },
    { promptSnippet: "Read file contents", promptGuidelines: ["Use read before editing."] },
  );
  const edit = withToolPromptMeta(
    { name: "edit", description: "edit", parameters: {}, execute: async () => ({}) },
    { promptSnippet: "Edit files", promptGuidelines: ["Keep edit matches short."] },
  );

  const toolsText = renderToolsSection([read] as never);
  assert.equal(toolsText, "- read: Read file contents");
  assert.equal(renderToolsSection([]), undefined);

  const rulesText = renderRulesSection([read] as never);
  assert.ok(rulesText?.includes("- Use read before editing."));
  assert.ok(rulesText?.includes("- Be concise in your responses"));
  assert.ok(rulesText?.includes("- Show file paths clearly when working with files"));
  assert.equal(rulesText?.includes("Keep edit matches short."), false);
  assert.equal(renderRulesSection([]), undefined);
  assert.ok(renderToolsSection([read, edit] as never)?.includes("- edit: Edit files"));
});

test("createBaseExtension exposes preamble, tools, rules, cwd, agent-context, and skills in order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "AGENTS.md"), "project rules");
    const extension = createBaseExtension({ workspaces: [dir] });
    assert.equal(extension.name, "eevee.base");
    const keys = (extension.sections ?? []).map((entry) => entry.key);
    assert.deepEqual(keys, ["preamble", "tools", "rules", "cwd", "agent-context", "skills"]);

    const input = promptInput(dir, ["read", "bash"]);
    const preamble = await sectionByKey(extension, "preamble").render(input, {} as never);
    assert.ok(preamble?.includes("Eevee"));
    const cwd = await sectionByKey(extension, "cwd").render(input, {} as never);
    assert.equal(cwd, dir.replace(/\\/g, "/"));
    const agentContext = await sectionByKey(extension, "agent-context").render(input, {} as never);
    assert.ok(agentContext?.includes("project rules"));
    assert.equal(agentContext?.includes("workspace="), false);
  });
});

test("skills section renders only with a reading capability and hides disable-model-invocation skills", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".pi", "skills", "open"), { recursive: true });
    await mkdir(join(dir, ".pi", "skills", "hidden"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "skills", "open", "SKILL.md"),
      "---\nname: open\ndescription: visible skill\n---\n",
    );
    await writeFile(
      join(dir, ".pi", "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: not for the model\ndisable-model-invocation: true\n---\n",
    );
    const extension = createBaseExtension({ workspaces: [dir] });
    const skills = sectionByKey(extension, "skills");

    const withoutReader = await skills.render(promptInput(dir, ["write"]), {} as never);
    assert.equal(withoutReader, undefined);

    const withRead = await skills.render(promptInput(dir, ["read"]), {} as never);
    assert.ok(withRead?.includes("open"));
    assert.ok(withRead?.includes("visible skill"));
    assert.ok(!withRead?.includes("not for the model"));
    assert.ok(withRead?.includes("Use read to load"));

    const withBash = await skills.render(promptInput(dir, ["bash"]), {} as never);
    assert.ok(withBash?.includes("Use bash to load"));

    const withCodemode = await skills.render(promptInput(dir, ["codemode"], ["read"]), {} as never);
    assert.ok(
      withCodemode?.includes(
        "Use codemode (tools.read) to load a skill's file when the task matches its description.",
      ),
    );
  });
});

test("a dynamic workspaces getter switches discovered files on the next prompt render", async () => {
  await withTempDir(async (dir) => {
    const wsA = join(dir, "ws-a");
    const wsB = join(dir, "ws-b");
    await mkdir(join(wsA, ".pi", "skills", "alpha"), { recursive: true });
    await mkdir(join(wsB, ".pi", "skills", "beta"), { recursive: true });
    await writeFile(join(wsA, "AGENTS.md"), "rules from workspace A");
    await writeFile(join(wsB, "AGENTS.md"), "rules from workspace B");
    await writeFile(
      join(wsA, ".pi", "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: skill a\n---\n",
    );
    await writeFile(
      join(wsB, ".pi", "skills", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: skill b\n---\n",
    );

    let current = wsA;
    const extension = createBaseExtension({ workspaces: () => [current] });

    const inputA = promptInput(wsA, ["read"]);
    const contextA = await sectionByKey(extension, "agent-context").render(inputA, {} as never);
    const skillsA = await sectionByKey(extension, "skills").render(inputA, {} as never);
    assert.ok(contextA?.includes("rules from workspace A"));
    assert.ok(!contextA?.includes("rules from workspace B"));
    assert.ok(skillsA?.includes("<name>alpha</name>"));
    assert.ok(!skillsA?.includes("<name>beta</name>"));

    current = wsB;
    const inputB = promptInput(wsB, ["read"]);
    const contextB = await sectionByKey(extension, "agent-context").render(inputB, {} as never);
    const skillsB = await sectionByKey(extension, "skills").render(inputB, {} as never);
    assert.ok(contextB?.includes("rules from workspace B"));
    assert.ok(!contextB?.includes("rules from workspace A"));
    assert.ok(skillsB?.includes("<name>beta</name>"));
    assert.ok(!skillsB?.includes("<name>alpha</name>"));
  });
});

test("agent-context and skills share one discovery scan per render input", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "AGENTS.md"), "shared scan rules");
    await mkdir(join(dir, ".pi", "skills", "s"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: x\n---\n",
    );
    const extension = createBaseExtension({ workspaces: [dir] });
    const input = promptInput(dir, ["read"]);
    const agentContext = await sectionByKey(extension, "agent-context").render(input, {} as never);
    const skills = await sectionByKey(extension, "skills").render(input, {} as never);
    assert.ok(agentContext?.includes("shared scan rules"));
    assert.ok(skills?.includes("<name>s</name>"));
  });
});
