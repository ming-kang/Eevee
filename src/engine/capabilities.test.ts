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
      description: "查资料",
      parameters: obj({ q: str() }),
      deferred: true,
      replay: "safe",
      execute: async (args) => ({ output: [{ type: "text", text: `查到 ${args.q}` }] }),
    }),
  ],
});

test("settings 为角色启用的扩展生效，延迟加载的工具经 tool_search 找到", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role !== "router") return say("好的。");
    if (last?.role === "user" && textOf(last).includes("查一下")) {
      return call("tool_search", { query: "查资料" });
    }
    if (toolName(last) === "tool_search") return call("lookup", { q: "光学" });
    if (toolName(last) === "lookup") return say(`结果：${textOf(last)}`);
    return say("好的。");
  };
  const project = await openTestProject(brain, {
    shared: [createToolSearchExtension(), research],
    roles: { router: { extensions: ["research"] } },
  });
  try {
    await project.host.sendUserMessage("查一下光学");
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) => l.text === "结果：查到 光学"),
    );
    const turns = project.calls.filter((c) => c.role === "router");
    assert.ok(turns[0]?.tools.includes("tool_search"));
    assert.ok(!turns[0]?.tools.includes("lookup"));
    assert.ok(turns.at(-1)?.tools.includes("lookup"));
  } finally {
    await project.close();
  }
});

test("停用扩展后重新应用角色，工具不再提供；没安装的扩展先跳过", async () => {
  const brain: Brain = () => say("好的。");
  const project = await openTestProject(brain, {
    shared: [createToolSearchExtension(), research],
    roles: { router: { extensions: ["research", "mcp.gone"] } },
  });
  try {
    await project.host.sendUserMessage("第一句");
    await project.until(async () => project.calls.length >= 1);
    assert.ok(project.calls[0]?.tools.includes("tool_search"));

    project.settings.roles = {};
    await project.host.refreshExtensions();
    await project.host.sendUserMessage("第二句");
    await project.until(async () => project.calls.length >= 2);
    assert.ok(!project.calls[1]?.tools.includes("tool_search"));
  } finally {
    await project.close();
  }
});

test("Router 用 ticket model 中途给工单换模型，下一次请求起生效", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("开工")) {
        return call("ticket", {
          action: "create",
          title: "换模型",
          goal: "试试",
          acceptance: ["无"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("报告 · waiting")) {
        return call("ticket", {
          action: "model",
          ticketId: "t1",
          provider: "faux",
          modelId: "brain-pro",
          modelReason: "需要更强的推理",
        });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("改用")) {
        return call("ticket", { action: "message", ticketId: "t1", text: "继续" });
      }
      return say("好的。");
    }
    if (textOf(last).includes("继续")) {
      return call("report", { status: "ready", summary: "换完了", artifacts: [] });
    }
    if (last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary: "做了一半",
        need: "更强的模型",
        artifacts: [],
      });
    }
    return say("等待。");
  };
  const project = await openTestProject(brain, { extraModels: ["brain-pro"] });
  try {
    await project.host.sendUserMessage("开工");
    const ticket = await project.until(async () => {
      const board = await project.host.board();
      const found = board.tickets[0];
      return found?.reports.some((r) => r.status === "ready") && found.ticket;
    });
    assert.deepEqual(ticket.model, { provider: "faux", modelId: "brain-pro" });
    assert.equal(ticket.modelReason, "需要更强的推理");
    const workerModels = project.calls.filter((c) => c.role === "worker").map((c) => c.model);
    assert.equal(workerModels[0], "brain");
    assert.equal(workerModels.at(-1), "brain-pro");
  } finally {
    await project.close();
  }
});
