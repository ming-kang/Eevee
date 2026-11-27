import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { translateFor } from "../src/lib/i18n.ts";
import { buildPaletteItems } from "../src/lib/palette-items.ts";

const project: ProjectSummary = {
  id: "p1" as ProjectId,
  title: "Eevee",
  workspaces: ["/tmp/eevee"],
  createdAt: 1,
  updatedAt: 1,
};

const boards: Record<string, BoardViewPayload> = {
  p1: {
    workers: [
      {
        id: "w1" as WorkerId,
        name: "UI",
        cwd: "/tmp/eevee",
        conversationId: 2,
        createdAt: 10,
        status: "running",
        activeTaskCount: 0,
        tasks: [],
      },
      {
        id: "w2" as WorkerId,
        name: "Done",
        cwd: "/tmp/eevee",
        conversationId: 3,
        createdAt: 5,
        status: "closed",
        activeTaskCount: 0,
        tasks: [],
      },
    ],
    tickets: [],
    questions: [],
  },
};

test("buildPaletteItems includes active project views, settings shortcut, and open workers only", () => {
  const noop = () => {};
  const items = buildPaletteItems({
    projects: [project],
    boards,
    activeProject: project,
    themeLabel: "System",
    t: (key, params) => translateFor("en", key, params),
    onOpenOverview: noop,
    onOpenProject: noop,
    onNewProject: noop,
    onOpenControl: noop,
    onCycleTheme: noop,
    onOpenShortcuts: noop,
    onToggleSide: noop,
    onToggleRail: noop,
  });

  const ids = items.map((item) => item.id);
  assert.ok(ids.includes("nav:active-router"));
  assert.ok(ids.includes("nav:active-memory"));
  assert.ok(ids.includes("nav:active-usage"));
  assert.ok(ids.includes("act:toggle-rail"));
  assert.ok(ids.includes("worker:p1:w1"));
  assert.ok(!ids.includes("worker:p1:w2"));

  const settings = items.find((item) => item.id === "act:settings");
  assert.equal(settings?.keys?.[1], ",");
});
