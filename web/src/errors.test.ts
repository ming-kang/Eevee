import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError } from "../../src/api/client.ts";
import { configIssueText, configProblemText, errorText, problemText } from "./errors.ts";
import { StreamError } from "./stream.ts";

test("拒绝按 code 和参数措辞，不用 Engine 的原话", () => {
  const refused = new ApiRequestError(409, {
    code: "ticket_closed",
    ticketId: "t3",
    message: "Engine 的原话",
  });
  assert.equal(errorText(refused), "t3 已经结单");
  assert.equal(
    errorText(new StreamError({ code: "no_job", jobId: "j2", message: "Engine 的原话" })),
    "没有作业 j2",
  );
  assert.equal(
    problemText({ code: "invalid", field: "mode", allowed: ["steer", "followUp"] }),
    "mode 只能是 steer / followUp",
  );
  assert.equal(problemText({ code: "model_unset", role: "worker" }), "Worker 没有可用的模型");
});

test("意料之外的错误显示它自己的文字", () => {
  assert.equal(problemText({ code: "internal", detail: "ECONNRESET" }), "ECONNRESET");
  assert.equal(errorText(new Error("网络断了")), "网络断了");
  assert.equal(errorText("超时"), "超时");
});

test("配置问题写出条目，文件名留给所在的标题", () => {
  assert.equal(
    configProblemText({
      file: "mcp.json",
      entry: "bad",
      code: "invalid",
      field: "exposure",
      allowed: ["deferred", "direct"],
    }),
    "bad：exposure 只能是 deferred / direct",
  );
  assert.equal(
    configProblemText({
      file: "models.json",
      code: "schema",
      path: "/providers",
      detail: "Expected object",
    }),
    "/providers：Expected object",
  );
  assert.equal(
    configIssueText({ code: "env_unset", name: "API_TOKEN" }),
    "API_TOKEN 引用的环境变量没有设置",
  );
});
