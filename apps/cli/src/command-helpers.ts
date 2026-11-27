import { connectLocalEngine, type LocalEngineConnection } from "@eevee/engine";
import type { EeveeClient } from "@eevee/protocol";
import { installSignalAbort } from "./args.ts";

export type JsonOptions = {
  readonly json?: boolean;
};

export function printResult<T>(
  result: T,
  options: JsonOptions,
  format: (result: T) => string | undefined,
): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const formatted = format(result);
  if (formatted !== undefined) {
    console.log(formatted);
  }
}

export async function runEngineCommand<T>(
  env: NodeJS.ProcessEnv,
  options: JsonOptions,
  run: (client: EeveeClient, connection: LocalEngineConnection) => Promise<T>,
  format: (result: T) => string | undefined,
): Promise<void> {
  const connection = await connectLocalEngine(env);
  const result = await run(connection.client, connection);
  printResult(result, options, format);
}

export async function withSignalAbort<T>(
  run: (signal: AbortSignal, controller: AbortController) => Promise<T>,
  onAbort?: () => void,
): Promise<T | undefined> {
  const controller = new AbortController();
  const cleanup = installSignalAbort(controller);
  const handleAbort = () => onAbort?.();
  if (onAbort !== undefined) {
    controller.signal.addEventListener("abort", handleAbort, { once: true });
  }
  try {
    return await run(controller.signal, controller);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return undefined;
  } finally {
    if (onAbort !== undefined) {
      controller.signal.removeEventListener("abort", handleAbort);
    }
    cleanup();
  }
}
