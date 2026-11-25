import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBaseExtension,
  discoverContextFiles,
  discoverSkills,
  guidelinesForTools,
  parseSkillFrontmatter,
} from "../src/context/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-context-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function promptInput(cwd: string | undefined, tools: readonly string[]) {
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

test("guidelinesForTools renders guidance only for offered tools", () => {
  const text = guidelinesForTools(["read", "bash"]);
  assert.ok(text?.includes("read to inspect"));
  assert.ok(text?.includes("bash for builds"));
  assert.equal(text?.includes("edit for targeted"), false);
  assert.equal(guidelinesForTools([]), undefined);
});

test("createBaseExtension exposes preamble, cwd, agent-context, skills, and tool-guidelines", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "AGENTS.md"), "project rules");
    const extension = createBaseExtension({ workspaces: [dir] });
    assert.equal(extension.name, "eevee.base");
    const keys = (extension.sections ?? []).map((entry) => entry.key);
    assert.deepEqual(keys, ["preamble", "cwd", "agent-context", "skills", "tool-guidelines"]);

    const input = promptInput(dir, ["read", "bash"]);
    const sections = extension.sections ?? [];
    const preamble = await sections[0]?.render(input, {} as never);
    assert.ok(preamble?.includes("Eevee"));
    const cwd = await sections[1]?.render(input, {} as never);
    assert.equal(cwd, dir.replace(/\\/g, "/"));
    const agentContext = await sections[2]?.render(input, {} as never);
    assert.ok(agentContext?.includes("project rules"));
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
    const skills = extension.sections?.[3];
    assert.ok(skills);

    const withoutReader = await skills.render(promptInput(dir, ["write"]), {} as never);
    assert.equal(withoutReader, undefined);

    const withRead = await skills.render(promptInput(dir, ["read"]), {} as never);
    assert.ok(withRead?.includes("open"));
    assert.ok(withRead?.includes("visible skill"));
    assert.ok(!withRead?.includes("not for the model"));
    assert.ok(withRead?.includes("Use read to load"));

    const withBash = await skills.render(promptInput(dir, ["bash"]), {} as never);
    assert.ok(withBash?.includes("Use bash to load"));
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
    const agentContext = await extension.sections?.[2]?.render(input, {} as never);
    const skills = await extension.sections?.[3]?.render(input, {} as never);
    assert.ok(agentContext?.includes("shared scan rules"));
    assert.ok(skills?.includes("<name>s</name>"));
  });
});
