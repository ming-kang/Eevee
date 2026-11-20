import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError } from "../../../src/api/client.ts";
import { configIssueText, configProblemText, errorText, problemText } from "./errors.ts";
import { StreamError } from "./stream.ts";

test("a refusal is worded by code and parameters, not by the Engine's own words", () => {
  const refused = new ApiRequestError(409, {
    code: "ticket_closed",
    ticketId: "t3",
    message: "the Engine's own words",
  });
  assert.equal(errorText(refused), "t3 is already closed");
  assert.equal(
    errorText(new StreamError({ code: "no_job", jobId: "j2", message: "the Engine's own words" })),
    "No job j2",
  );
  assert.equal(
    problemText({ code: "invalid", field: "mode", allowed: ["steer", "followUp"] }),
    "mode must be one of steer / followUp",
  );
  assert.equal(
    problemText({ code: "model_unset", role: "worker" }),
    "worker has no model. Under models in settings.json, set a default or the worker model. You can also name a provider and modelId when you create the ticket.",
  );
});

test("an unexpected error shows its own text", () => {
  assert.equal(problemText({ code: "internal", detail: "ECONNRESET" }), "ECONNRESET");
  assert.equal(errorText(new Error("the network dropped")), "the network dropped");
  assert.equal(errorText("timed out"), "timed out");
});

test("a config problem names the entry and leaves the file to its heading", () => {
  assert.equal(
    configProblemText({
      file: "mcp.json",
      entry: "bad",
      code: "invalid",
      field: "exposure",
      allowed: ["deferred", "direct"],
    }),
    "bad: exposure must be one of deferred / direct",
  );
  assert.equal(
    configProblemText({
      file: "models.json",
      code: "schema",
      path: "/providers",
      detail: "Expected object",
    }),
    "/providers: Expected object",
  );
  assert.equal(
    configIssueText({ code: "env_unset", name: "API_TOKEN" }),
    "API_TOKEN refers to an environment variable that is not set",
  );
});
