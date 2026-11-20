import assert from "node:assert/strict";
import test from "node:test";
import {
  activityLabel,
  countSteps,
  countWork,
  editSummary,
  formatToolLabel,
  runningLabel,
  toolActivity,
} from "./activity.ts";
import type { ToolStepItem, TranscriptDisplayItem } from "./transcript-map.ts";

const step = (tool: string, status: ToolStepItem["status"] = "ok"): ToolStepItem => ({
  id: tool,
  tool,
  label: "x",
  status,
});

const editItem = (
  key: string,
  path: string,
  added: number,
  removed: number,
  status: "ok" | "err" | "run" = "ok",
): TranscriptDisplayItem => ({
  kind: "edit",
  key,
  action: "edit",
  path,
  status,
  diff: [],
  added,
  removed,
});

const bashItem = (key: string): TranscriptDisplayItem => ({
  kind: "bash",
  key,
  command: "ls",
  status: "exit",
  output: "",
});

const toolsItem = (key: string, tools: string[]): TranscriptDisplayItem => ({
  kind: "tools",
  key,
  live: false,
  steps: tools.map((tool, i) => ({ id: `${key}:${i}`, tool, label: "x", status: "ok" })),
});

test("tool names map to their activity kind; unknown and MCP tools are 'tools'", () => {
  assert.equal(toolActivity("read"), "read");
  assert.equal(toolActivity("write"), "edit");
  assert.equal(toolActivity("edit"), "edit");
  assert.equal(toolActivity("bash"), "commands");
  assert.equal(toolActivity("memory"), "memory");
  assert.equal(toolActivity("tool_search"), "search");
  assert.equal(toolActivity("codemode"), "scripts");
  assert.equal(toolActivity("handoff"), "handoff");
  assert.equal(toolActivity("mcp.weather"), "tools");
  assert.equal(toolActivity("anything"), "tools");
});

test("countWork counts edit and bash items and steps inside tools items, nothing else", () => {
  const counts = countWork([
    editItem("e1", "a.ts", 1, 0),
    bashItem("b1"),
    toolsItem("t1", ["read", "read", "tool_search", "mcp.one"]),
    { kind: "thinking", key: "th", text: "hmm" },
    { kind: "assistant", key: "a", text: "hi" },
    { kind: "dispatch", key: "d", live: false, actions: [] },
  ]);
  assert.deepEqual(counts, [
    { kind: "edit", count: 1 },
    { kind: "commands", count: 1 },
    { kind: "read", count: 2 },
    { kind: "search", count: 1 },
    { kind: "tools", count: 1 },
  ]);
});

test("countSteps counts every step by its tool", () => {
  assert.deepEqual(countSteps([step("read"), step("read"), step("bash")]), [
    { kind: "read", count: 2 },
    { kind: "commands", count: 1 },
  ]);
});

test("the finished label sorts by count, breaks ties by first appearance, and truncates past three", () => {
  const label = activityLabel([
    { kind: "commands", count: 2 },
    { kind: "read", count: 5 },
    { kind: "edit", count: 3 },
  ]);
  assert.equal(label, "Read 5 files · Edited 3 files · Ran 2 commands");
});

test("plurals and categories read per spec", () => {
  assert.equal(activityLabel([{ kind: "read", count: 1 }]), "Read 1 file");
  assert.equal(activityLabel([{ kind: "edit", count: 1 }]), "Edited 1 file");
  assert.equal(activityLabel([{ kind: "commands", count: 1 }]), "Ran 1 command");
  assert.equal(activityLabel([{ kind: "memory", count: 1 }]), "Used memory once");
  assert.equal(activityLabel([{ kind: "memory", count: 2 }]), "Used memory 2 times");
  assert.equal(activityLabel([{ kind: "search", count: 1 }]), "Searched tools once");
  assert.equal(activityLabel([{ kind: "scripts", count: 1 }]), "Ran a script");
  assert.equal(activityLabel([{ kind: "scripts", count: 2 }]), "Ran 2 scripts");
  assert.equal(activityLabel([{ kind: "handoff", count: 1 }]), "Handed off");
  assert.equal(activityLabel([{ kind: "tools", count: 1 }]), "Called a tool once");
  assert.equal(activityLabel([{ kind: "tools", count: 4 }]), "Called tools 4 times");
});

test("more than three kinds ends in an ellipsis", () => {
  const label = activityLabel([
    { kind: "read", count: 1 },
    { kind: "edit", count: 1 },
    { kind: "commands", count: 1 },
    { kind: "tools", count: 2 },
  ]);
  assert.equal(label, "Called tools 2 times · Read 1 file · Edited 1 file · …");
});

test("running labels use the kind's verb, then the step's detail", () => {
  assert.equal(runningLabel("read", "a.tex"), "Reading · a.tex");
  assert.equal(runningLabel("bash", "npm test"), "Running command · npm test");
  assert.equal(runningLabel("write", "x.ts"), "Editing · x.ts");
  assert.equal(runningLabel("memory", "add project"), "Using memory · add project");
  assert.equal(runningLabel("codemode", "build"), "Running script · build");
  assert.equal(runningLabel("mcp.weather", "forecast"), "Calling tool · forecast");
  assert.equal(runningLabel("handoff", "ctx"), "Calling tool · ctx");
});

test("formatToolLabel keeps its special cases", () => {
  assert.equal(
    formatToolLabel("read", { path: "a.tex", query: "fig", offset: 3 }),
    "a.tex:3?query=fig",
  );
  assert.equal(formatToolLabel("bash", { command: "ls -la" }), "ls -la");
  assert.equal(formatToolLabel("edit", { path: "x.ts" }), "x.ts");
  assert.equal(formatToolLabel("write", {}), "write");
  assert.equal(
    formatToolLabel("memory", { action: "add", scope: "project", file: "style" }),
    "add project/style",
  );
  assert.equal(
    formatToolLabel("memory", { action: "remove", scope: "global", change: 2 }),
    "remove global #2",
  );
  assert.equal(formatToolLabel("handoff", { summary: `${"s".repeat(61)}` }), `${"s".repeat(60)}…`);
});

test("formatToolLabel falls back through the priority fields, collapsing whitespace and clipping", () => {
  assert.equal(formatToolLabel("mcp.search", { query: "  two\nlines  " }), "two lines");
  assert.equal(formatToolLabel("mcp.x", { title: "", name: "the name" }), "the name");
  assert.equal(formatToolLabel("mcp.x", { message: ["one", "two"] }), "one, two");
  assert.equal(formatToolLabel("mcp.x", { prompt: "y".repeat(100) }), `${"y".repeat(79)}…`);
  assert.equal(formatToolLabel("mcp.x", {}), "mcp.x");
  assert.equal(formatToolLabel("mcp.x", { count: 3 }), "mcp.x");
});

test("editSummary counts distinct paths, sums successful edits, keeps first-seen order", () => {
  const summary = editSummary([
    editItem("e1", "a.ts", 3, 1),
    editItem("e2", "b.ts", 40, 6),
    editItem("e3", "a.ts", 2, 0),
    editItem("e4", "c.ts", 9, 9, "err"),
    editItem("e5", "d.ts", 5, 5, "run"),
    bashItem("b1"),
  ]);
  assert.ok(summary);
  assert.equal(summary.files, 2);
  assert.equal(summary.added, 45);
  assert.equal(summary.removed, 7);
  assert.deepEqual(summary.paths, [
    { key: "e1", path: "a.ts", added: 5, removed: 1 },
    { key: "e2", path: "b.ts", added: 40, removed: 6 },
  ]);
});
