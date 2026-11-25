import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export type HarnessFixture = {
  readonly dir: string;
  readonly env: NodeExecutionEnv;
  cleanup(): Promise<void>;
};

export async function createHarnessFixture(): Promise<HarnessFixture> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tools-test-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  return {
    dir,
    env,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
