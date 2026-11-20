import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTicketCommand, type TicketArgs, type TicketCommand } from "./ticket-command.ts";

const args = (overrides: Partial<TicketArgs> = {}): TicketArgs =>
  ({ action: "create", ...overrides }) as TicketArgs;

const reason = (overrides: Partial<TicketArgs>): string => {
  const parsed = parseTicketCommand(args(overrides));
  assert.equal(parsed.ok, false);
  return parsed.ok ? "" : parsed.reason;
};

const command = (overrides: Partial<TicketArgs>): TicketCommand => {
  const parsed = parseTicketCommand(args(overrides));
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.value : (undefined as never);
};

test("create names the fields it is missing, an empty string counting as missing", () => {
  assert.equal(
    reason({ action: "create", title: "", goal: "", acceptance: [] }),
    "create is missing fields: title, goal.",
  );
  assert.equal(
    reason({ action: "create", title: "Scan", goal: "run it" }),
    "create is missing fields: acceptance.",
  );
  assert.equal(reason({ action: "create" }), "create is missing fields: title, goal, acceptance.");
});

test("the provider, the model ID and the thinking level come together or not at all", () => {
  const pairing =
    "provider and modelId are filled in together or left out together (to use the default model).";
  assert.equal(
    reason({ action: "create", title: "t", goal: "g", acceptance: ["a"], provider: "faux" }),
    pairing,
  );
  assert.equal(
    reason({ action: "create", title: "t", goal: "g", acceptance: ["a"], modelId: "brain" }),
    pairing,
  );
  assert.equal(
    reason({
      action: "create",
      title: "t",
      goal: "g",
      acceptance: ["a"],
      thinkingLevel: "low",
    }),
    "thinkingLevel goes together with provider and modelId; see models:// for the default model.",
  );
  // The model action needs both fields, in its own words.
  assert.equal(reason({ action: "model", ticketId: "t1" }), "model needs provider and modelId.");
  assert.equal(
    reason({ action: "model", ticketId: "t1", provider: "faux" }),
    "model needs provider and modelId.",
  );
});

test("every action but create names the ticket it needs, and its own missing fields", () => {
  assert.equal(reason({ action: "message" }), "message needs a ticketId.");
  assert.equal(reason({ action: "review" }), "review needs a ticketId.");
  assert.equal(reason({ action: "message", ticketId: "t2" }), "message needs text.");
  assert.equal(reason({ action: "message", ticketId: "t2", text: "" }), "message needs text.");
  assert.equal(
    reason({ action: "review", ticketId: "t2", verdict: "accept" }),
    "review needs verdict and note.",
  );
  assert.equal(
    reason({ action: "review", ticketId: "t2", note: "" }),
    "review needs verdict and note.",
  );
  assert.equal(reason({ action: "close", ticketId: "t2" }), "close needs a note that says why.");
  assert.equal(
    reason({ action: "close", ticketId: "t2", note: "" }),
    "close needs a note that says why.",
  );
});

test("a complete command comes back narrowed, with its defaults filled in", () => {
  assert.deepEqual(
    command({
      action: "create",
      title: "Scan",
      goal: "run it",
      acceptance: ["converged"],
      deliverTo: ["t4"],
      output: "out/",
      provider: "faux",
      modelId: "brain",
      thinkingLevel: "low",
      modelReason: "cheapest",
    }),
    {
      action: "create",
      title: "Scan",
      goal: "run it",
      acceptance: ["converged"],
      inputs: [],
      deliverTo: ["t4"],
      output: "out/",
      model: { provider: "faux", modelId: "brain", thinkingLevel: "low" },
      modelReason: "cheapest",
    },
  );

  // No model, no inputs and no deliverTo: the defaults a handler would otherwise have to fill in.
  assert.deepEqual(
    command({ action: "create", title: "Scan", goal: "run it", acceptance: ["x"] }),
    {
      action: "create",
      title: "Scan",
      goal: "run it",
      acceptance: ["x"],
      inputs: [],
      deliverTo: [],
    },
  );

  assert.deepEqual(command({ action: "message", ticketId: "t2", text: "go on" }), {
    action: "message",
    ticketId: "t2",
    text: "go on",
    whenBusy: "followUp",
  });
  assert.deepEqual(command({ action: "message", ticketId: "t2", text: "go on", mode: "steer" }), {
    action: "message",
    ticketId: "t2",
    text: "go on",
    whenBusy: "steer",
  });
  assert.deepEqual(command({ action: "interrupt", ticketId: "t2" }), {
    action: "interrupt",
    ticketId: "t2",
  });
  assert.deepEqual(
    command({ action: "review", ticketId: "t2", verdict: "rework", note: "more data" }),
    {
      action: "review",
      ticketId: "t2",
      verdict: "rework",
      note: "more data",
    },
  );
  assert.deepEqual(command({ action: "close", ticketId: "t2", note: "not needed" }), {
    action: "close",
    ticketId: "t2",
    note: "not needed",
  });
  assert.deepEqual(
    command({
      action: "model",
      ticketId: "t2",
      provider: "faux",
      modelId: "deep",
      thinkingLevel: "high",
    }),
    {
      action: "model",
      ticketId: "t2",
      model: { provider: "faux", modelId: "deep", thinkingLevel: "high" },
    },
  );
});
