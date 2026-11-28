import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoardViewPayload,
  SkillEntry,
  TicketRecordPayload,
  WorkerBoardItemPayload,
  WorkspaceFile,
} from "@eevee/protocol";
import {
  chipForItem,
  mentionItems,
  SUGGESTION_TRIGGERS,
  searchesFiles,
  skillItems,
  suggestionTarget,
} from "../src/lib/composer-suggestions.ts";
import {
  fileChip,
  isInsideCode,
  isMessageEmpty,
  type MessageValue,
  messageText,
  normalizeMessageValue,
  skillChip,
  ticketChip,
  workerChip,
} from "../src/lib/composer-value.ts";

const file = (path: string): WorkspaceFile => {
  const slash = path.lastIndexOf("/");
  return {
    workspace: 0,
    path,
    name: path.slice(slash + 1),
    dir: slash === -1 ? "" : path.slice(0, slash),
    label: path,
    mimeType: "text/plain",
    size: 10,
  };
};

const skill = (name: string, description = ""): SkillEntry => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  source: "global",
  disableModelInvocation: false,
  defaultMode: "model",
  effectiveMode: "model",
});

const worker: WorkerBoardItemPayload = {
  id: "w1",
  name: "backend",
  cwd: "/repo",
  conversationId: 2,
  createdAt: 1,
  status: "running",
  activeTaskCount: 0,
  tasks: [],
};

const ticket: TicketRecordPayload = {
  id: "t1",
  workerId: "w1",
  title: "Fix login",
  status: "open",
  createdAt: 1,
};

const board: BoardViewPayload = { workers: [worker], tickets: [ticket], questions: [] };

test("messageText writes chips in the form the engine resolves", () => {
  const value: MessageValue = [
    "Compare ",
    fileChip(file("src/app.ts")),
    " with ",
    fileChip(file("docs/my notes.md")),
    " for ",
    workerChip(worker),
    " and ",
    ticketChip(ticket),
    " using ",
    skillChip(skill("review")),
  ];
  assert.equal(
    messageText(value),
    'Compare @src/app.ts with @"docs/my notes.md" for @w1 and @t1 using /skill:review',
  );
});

test("messageText keeps chips apart from adjacent text, including text without spaces", () => {
  const app = fileChip(file("src/app.ts"));
  assert.equal(messageText(["请看", app, "，谢谢"]), "请看 @src/app.ts ，谢谢");
  assert.equal(messageText([app, skillChip(skill("review"))]), "@src/app.ts /skill:review");
  assert.equal(messageText(["see\n", app, "\nnext"]), "see\n@src/app.ts\nnext");
  assert.equal(messageText([app]), "@src/app.ts");
});

test("isMessageEmpty treats chips as content and whitespace as empty", () => {
  assert.equal(isMessageEmpty([]), true);
  assert.equal(isMessageEmpty(["  \n "]), true);
  assert.equal(isMessageEmpty([skillChip(skill("review"))]), false);
});

test("normalizeMessageValue merges adjacent text and drops empty text", () => {
  const chip = skillChip(skill("review"));
  assert.deepEqual(normalizeMessageValue(["a", "", "b", chip, "", "c", "d"]), ["ab", chip, "cd"]);
});

test("isInsideCode counts a chip as one character and detects code spans and fences", () => {
  const chip = fileChip(file("src/app.ts"));
  assert.equal(isInsideCode(["run `@x"], { start: 5, end: 7 }), false);
  assert.equal(isInsideCode(["run `@x`"], { start: 5, end: 7 }), true);
  assert.equal(isInsideCode([chip, " `@x`"], { start: 3, end: 5 }), true);
  assert.equal(isInsideCode([chip, " @x"], { start: 2, end: 4 }), false);
  assert.equal(isInsideCode(["```\n@x\n```"], { start: 4, end: 6 }), true);
});

test("suggestionTarget maps triggers to mention scopes and skill lookups", () => {
  const characters = SUGGESTION_TRIGGERS.map((trigger) => trigger.character);
  assert.ok(characters.includes("@files:"));
  assert.ok(characters.includes("/skill:"));

  const range = { start: 0, end: 1 };
  assert.deepEqual(suggestionTarget({ character: "@", query: "src", range }), {
    kind: "mention",
    scope: "all",
    query: "src",
  });
  assert.deepEqual(suggestionTarget({ character: "@workers:", query: "w", range }), {
    kind: "mention",
    scope: "workers",
    query: "w",
  });
  assert.deepEqual(suggestionTarget({ character: "/skill:", query: "rev", range }), {
    kind: "skill",
    explicit: true,
    query: "rev",
  });
  assert.deepEqual(suggestionTarget({ character: "/", query: "", range }), {
    kind: "skill",
    explicit: false,
    query: "",
  });
});

test("searchesFiles only searches the workspace for unscoped and file mentions", () => {
  assert.equal(searchesFiles({ kind: "mention", scope: "all", query: "" }), true);
  assert.equal(searchesFiles({ kind: "mention", scope: "files", query: "" }), true);
  assert.equal(searchesFiles({ kind: "mention", scope: "tickets", query: "" }), false);
  assert.equal(searchesFiles({ kind: "skill", explicit: true, query: "" }), false);
});

test("suggestion items list files before board entries and become matching chips", () => {
  const items = mentionItems([file("src/app.ts")], board, "", "all");
  assert.deepEqual(
    items.map((item) => item.key),
    ["file:0:src/app.ts", "worker:w1", "ticket:t1"],
  );
  assert.deepEqual(
    items.map((item) => messageText([chipForItem(item)])),
    ["@src/app.ts", "@w1", "@t1"],
  );

  const skills = skillItems([skill("review"), skill("deploy", "ship a review build")], "rev");
  assert.deepEqual(
    skills.map((item) => messageText([chipForItem(item)])),
    ["/skill:review", "/skill:deploy"],
  );
});

test("chips get distinct ids", () => {
  const first = fileChip(file("src/app.ts"));
  const second = fileChip(file("src/app.ts"));
  assert.notEqual(first.id, second.id);
});
