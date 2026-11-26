import { spawn } from "node:child_process";
import {
  connectLocalEngine,
  DEFAULT_ENGINE_PORT,
  dataDirLayout,
  ENGINE_VERSION,
  getDaemonStatus,
  resolveDataDir,
  startDaemon,
  stopDaemon,
} from "@eevee/engine";
import { PROTOCOL_VERSION } from "@eevee/protocol";
import type { Command } from "commander";
import { parsePort } from "../args.ts";
import { formatDaemonStatus, runForegroundEngine, runSupervisorProcess } from "../lifecycle.ts";

function openExternalUrl(url: string): void {
  const command =
    process.platform === "win32"
      ? { bin: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : { bin: "xdg-open", args: [url] };
  const child = spawn(command.bin, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

export function registerDaemonCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  cliEntry: string,
): void {
  program
    .command("info")
    .description("Show resolved Eevee home layout and protocol version")
    .action(() => {
      const layout = dataDirLayout(resolveDataDir(env));
      console.log(
        JSON.stringify(
          {
            engineVersion: ENGINE_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            home: layout.root,
            authFile: layout.authFile,
            modelsFile: layout.modelsFile,
            engineDb: layout.engineDb,
            tokenFile: layout.tokenFile,
            stateFile: layout.stateFile,
            supervisorStateFile: layout.supervisorStateFile,
            daemonLogFile: layout.daemonLogFile,
          },
          null,
          2,
        ),
      );
    });

  program
    .command("start")
    .description("Start the local Eevee Engine")
    .option("--foreground", "Run the Engine in the foreground without a supervisor")
    .option("--port <port>", "Port to listen on (127.0.0.1 only)")
    .option("--json", "Output JSON (background mode only)")
    .action(async (options: { foreground?: boolean; port?: string; json?: boolean }) => {
      const port = options.port === undefined ? DEFAULT_ENGINE_PORT : parsePort(options.port);
      if (options.foreground) {
        await runForegroundEngine({ env, port });
        return;
      }
      const result = await startDaemon({
        env,
        port,
        cliEntry,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        result.outcome === "already_running"
          ? `Eevee engine is already running at ${result.url} (pid ${result.enginePid})`
          : `Started Eevee engine at ${result.url} (pid ${result.enginePid}, supervisor pid ${result.supervisorPid})`,
      );
    });

  program
    .command("stop")
    .description("Stop the supervised local Eevee Engine")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await stopDaemon({ env });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        result.outcome === "already_stopped"
          ? "Eevee engine is already stopped"
          : "Stopped Eevee engine",
      );
    });

  program
    .command("status")
    .description("Show local Eevee Engine and supervisor status")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const status = await getDaemonStatus({ env });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatDaemonStatus(status));
    });

  program
    .command("web")
    .description("Print a one-time login link for the local Eevee Web UI")
    .option("--open", "Open the Web UI in the default browser")
    .option("--json", "Output JSON")
    .action(async (options: { open?: boolean; json?: boolean }) => {
      const { url, client } = await connectLocalEngine(env);
      const { ticket, expiresAt } = await client.createWebTicket();
      const loginUrl = `${url}/#ticket=${ticket}`;
      if (options.open) {
        openExternalUrl(loginUrl);
      }
      if (options.json) {
        console.log(JSON.stringify({ url: loginUrl, expiresAt }, null, 2));
        return;
      }
      console.log(`Eevee Web UI (one-time login link, valid 10 minutes):\n${loginUrl}`);
    });

  program
    .command("__supervisor", { hidden: true })
    .description("Run the Eevee supervisor process")
    .option("--port <port>", "Port for the supervised Engine")
    .action(async (options: { port?: string }) => {
      const port = options.port === undefined ? DEFAULT_ENGINE_PORT : parsePort(options.port);
      await runSupervisorProcess({ env, port, cliEntry });
    });
}
