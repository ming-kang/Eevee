import { type DaemonStatus, runSupervisor, startForegroundEngine } from "@eevee/engine";

export async function runForegroundEngine(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
}): Promise<void> {
  let stopping = false;
  let requestShutdown = () => {};
  const handle = await startForegroundEngine({
    env: options.env,
    port: options.port,
    onShutdown: () => requestShutdown(),
    onRecoveryError: (error) => {
      console.error(
        `Project recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  console.log(`Eevee engine listening on ${handle.url} (pid ${handle.state.pid})`);

  await new Promise<void>((resolveStop, rejectStop) => {
    const removeListeners = () => {
      process.off("SIGINT", requestShutdown);
      process.off("SIGTERM", requestShutdown);
      process.off("message", onMessage);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "eevee:shutdown"
      ) {
        requestShutdown();
      }
    };
    requestShutdown = () => {
      if (stopping) return;
      stopping = true;
      void handle.close().then(
        () => {
          removeListeners();
          if (process.connected) process.disconnect?.();
          resolveStop();
        },
        (error: unknown) => {
          removeListeners();
          if (process.connected) process.disconnect?.();
          rejectStop(error);
        },
      );
    };
    process.on("SIGINT", requestShutdown);
    process.on("SIGTERM", requestShutdown);
    process.on("message", onMessage);
  });
}

export async function runSupervisorProcess(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly cliEntry: string;
  readonly port: number;
}): Promise<void> {
  await runSupervisor(options);
}

export function formatDaemonStatus(status: DaemonStatus): string {
  if (status.status === "stopped") return "Eevee engine is stopped";
  const engine = status.enginePid === undefined ? "not running" : `pid ${status.enginePid}`;
  const supervisor =
    status.supervisorPid === undefined ? "" : `, supervisor pid ${status.supervisorPid}`;
  const url = status.url === undefined ? "" : ` at ${status.url}`;
  const restarts = status.restartCount === 0 ? "" : `, ${status.restartCount} restart(s)`;
  return `Eevee engine is ${status.status} (${engine}${supervisor}${restarts})${url}`;
}
