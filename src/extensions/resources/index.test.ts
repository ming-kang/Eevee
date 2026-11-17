import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Report } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createResources } from "./index.ts";

test("read 读取工作区文件时不触发 structuredOutput 契约错误", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "eevee-read-"));
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "hello.txt"), "hello world\n");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "ticket://" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "bad://addr" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("读完了。"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const registry = createRegistry();
    registry.install(
      createResources({
        memoryDir: () => workspace,
        jobLog: (id) => join(workspace, `${id}.log`),
        models: async () => "",
        transcript: {
          entry: async () => undefined,
          page: async () => undefined,
        },
      }),
    );

    const reports: Report[] = [];
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: () => models,
        registry,
        env: () => new NodeExecutionEnv({ cwd: workspace }),
        onReport: (report) => reports.push(report),
      },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "faux", modelId: "m1" } },
      });
      await root.submit({ type: "input", content: "读取 hello.txt" }, BACKGROUND_CONTEXT);
      await root.waitForIdle(BACKGROUND_CONTEXT);
      assert.deepEqual(reports, []);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});
