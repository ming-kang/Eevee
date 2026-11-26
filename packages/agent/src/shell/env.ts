import type { Context } from "@earendil-works/chord/context";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv, type NodeWatchOptions } from "@earendil-works/pi-durable/env/node";
import { type BashShellConfig, resolveBashShell } from "./discovery.ts";
import { normalizePosixBashCommand } from "./normalize.ts";

export type ManagedExecutionEnvOptions = {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly watch?: NodeWatchOptions;
  readonly execEnv?: ExecutionEnv;
};

class ManagedExecutionEnv extends NodeExecutionEnv {
  readonly #platform: NodeJS.Platform;
  readonly #explicitShellPath: string | undefined;
  readonly #shellEnv: NodeJS.ProcessEnv | undefined;
  readonly #watch: NodeWatchOptions | undefined;
  readonly #execEnv: ExecutionEnv | undefined;
  #resolvedBash: Promise<BashShellConfig | undefined> | undefined;
  #shellDelegate: NodeExecutionEnv | undefined;

  constructor(options: ManagedExecutionEnvOptions) {
    super({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    });
    this.#platform = options.platform ?? process.platform;
    this.#explicitShellPath = options.shellPath;
    this.#shellEnv = options.shellEnv;
    this.#watch = options.watch;
    this.#execEnv = options.execEnv;
  }

  #resolveBash(): Promise<BashShellConfig | undefined> {
    this.#resolvedBash ??= resolveBashShell({
      platform: this.#platform,
      ...(this.#shellEnv === undefined ? {} : { env: this.#shellEnv }),
    });
    return this.#resolvedBash;
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (typeof command !== "string") {
      if (this.#execEnv !== undefined) {
        return this.#execEnv.exec(command, options, context);
      }
      return super.exec(command, options, context);
    }

    const effectiveCommand = normalizePosixBashCommand(command, this.#platform).command;

    if (this.#execEnv !== undefined) {
      return this.#execEnv.exec(effectiveCommand, options, context);
    }

    if (this.#explicitShellPath !== undefined) {
      return super.exec(effectiveCommand, options, context);
    }

    const resolved = await this.#resolveBash();
    if (resolved === undefined) {
      if (this.#platform === "win32") {
        return err(
          new ExecutionError(
            "shell_unavailable",
            "No bash shell found. Install Git for Windows or configure an explicit shellPath.",
          ),
        );
      }
      return super.exec(effectiveCommand, options, context);
    }

    if (this.#shellDelegate === undefined) {
      this.#shellDelegate = new NodeExecutionEnv({
        cwd: this.cwd,
        shellPath: resolved.shell,
        ...(this.#shellEnv === undefined ? {} : { shellEnv: this.#shellEnv }),
        ...(this.#watch === undefined ? {} : { watch: this.#watch }),
      });
    } else {
      this.#shellDelegate.cwd = this.cwd;
    }

    return this.#shellDelegate.exec(effectiveCommand, options, context);
  }

  override async cleanup(context: Context): Promise<void> {
    await super.cleanup(context);
    await this.#shellDelegate?.cleanup(context);
    await this.#execEnv?.cleanup(context);
  }
}

export function createManagedExecutionEnv(options: ManagedExecutionEnvOptions): NodeExecutionEnv {
  return new ManagedExecutionEnv(options);
}
