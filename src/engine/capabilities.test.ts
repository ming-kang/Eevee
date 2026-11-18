import assert from "node:assert/strict";
import { test } from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { obj, str } from "@earendil-works/pi-schema";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

const research = defineExtension({
  name: "research",
  tools: [
    defineTool({
      name: "lookup",
      description: "look things up",
      parameters: obj({ q: str() }),
      deferred: true,
      replay: "safe",
      execute: async (args) => ({ output: [{ type: "text", text: `found ${args.q}` }] }),
    }),
  ],
});

test("settings-enabled extensions take effect for a role, and deferred tools are found through tool_search", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role !== "router") return say("OK.");
    if (last?.role === "user" && textOf(last).includes("look up")) {
      return call("tool_search", { query: "look things up" });
    }
    if (toolName(last) === "tool_search") return call("lookup", { q: "optics" });
    if (toolName(last) === "lookup") return say(`result: ${textOf(last)}`);
    return say("OK.");
  };
  const project = await openTestProject(brain, {
    shared: [createToolSearchExtension(), research],
    roles: { router: { extensions: ["research"] } },
  });
  try {
    await project.host.sendUserMessage("look up optics");
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) => l.text === "result: found optics"),
    );
    const turns = project.calls.filter((c) => c.role === "router");
    assert.ok(turns[0]?.tools.includes("tool_search"));
    assert.ok(!turns[0]?.tools.includes("lookup"));
    assert.ok(turns.at(-1)?.tools.includes("lookup"));
  } finally {
    await project.close();
  }
});

test("after disabling extensions and reapplying a role, its tools are gone; uninstalled extensions are skipped", async () => {
  const brain: Brain = () => say("OK.");
  const project = await openTestProject(brain, {
    shared: [createToolSearchExtension(), research],
    roles: { router: { extensions: ["research", "mcp.gone"] } },
  });
  try {
    await project.host.sendUserMessage("first line");
    await project.until(async () => project.calls.length >= 1);
    assert.ok(project.calls[0]?.tools.includes("tool_search"));

    project.settings.roles = {};
    await project.host.refreshExtensions();
    await project.host.sendUserMessage("second line");
    await project.until(async () => project.calls.length >= 2);
    assert.ok(!project.calls[1]?.tools.includes("tool_search"));
  } finally {
    await project.close();
  }
});

test("the Router switches a ticket's model midway with ticket model, effective from its next request", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("start work")) {
        return call("ticket", {
          action: "create",
          title: "switch model",
          goal: "give it a try",
          acceptance: ["none"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("report · waiting")) {
        return call("ticket", {
          action: "model",
          ticketId: "t1",
          provider: "faux",
          modelId: "brain-pro",
          modelReason: "needs stronger reasoning",
        });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("now uses")) {
        return call("ticket", { action: "message", ticketId: "t1", text: "keep going" });
      }
      return say("OK.");
    }
    if (textOf(last).includes("keep going")) {
      return call("report", { status: "ready", summary: "switched", artifacts: [] });
    }
    if (last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary: "halfway done",
        need: "a stronger model",
        artifacts: [],
      });
    }
    return say("standing by.");
  };
  const project = await openTestProject(brain, { extraModels: ["brain-pro"] });
  try {
    await project.host.sendUserMessage("start work");
    const ticket = await project.until(async () => {
      const board = await project.host.board();
      const found = board.tickets[0];
      return found?.reports.some((r) => r.status === "ready") && found.ticket;
    });
    assert.deepEqual(ticket.model, { provider: "faux", modelId: "brain-pro" });
    assert.equal(ticket.modelReason, "needs stronger reasoning");
    const workerModels = project.calls.filter((c) => c.role === "worker").map((c) => c.model);
    assert.equal(workerModels[0], "brain");
    assert.equal(workerModels.at(-1), "brain-pro");
  } finally {
    await project.close();
  }
});
