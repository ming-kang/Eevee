import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";

export type TestHarness = {
  readonly harness: Harness;
  readonly registry: Registry;
  readonly faux: FauxProviderHandle;
  readonly env: NodeExecutionEnv;
  readonly dir: string;
  createConversation(agent?: AgentChange): Promise<Conversation>;
  cleanup(): Promise<void>;
};

export type TestHarnessOptions = {
  readonly extensions?: readonly Extension[];
  readonly cwd?: string;
};

export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-harness-test-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of options.extensions ?? []) {
    registry.install(extension);
  }
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => env,
    },
    BACKGROUND_CONTEXT,
  );

  const providerId = faux.provider.id;
  return {
    harness,
    registry,
    faux,
    env,
    dir,
    createConversation: (agent) =>
      harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: providerId, modelId: "faux-1" },
            extensions: (options.extensions ?? []) as never,
            ...agent,
          },
        },
        BACKGROUND_CONTEXT,
      ),
    cleanup: async () => {
      await harness.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}
