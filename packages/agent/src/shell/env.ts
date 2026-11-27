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
import { type NormalizeCommandResult, normalizePosixBashCommand } from "./normalize.ts";

export type ManagedExecutionEnvOptions = {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly watch?: NodeWatchOptions;
  readonly execEnv?: ExecutionEnv;
};

function isPlatformEnv(
  env: ExecutionEnv,
): env is ExecutionEnv & { readonly platform: NodeJS.Platform } {
  return "platform" in env && typeof env.platform === "string";
}

export function normalizeCommandForEnv(
  env: ExecutionEnv,
  command: string,
  platform?: NodeJS.Platform,
): NormalizeCommandResult {
  const effectivePlatform = platform ?? (isPlatformEnv(env) ? env.platform : process.platform);
  return normalizePosixBashCommand(command, effectivePlatform);
}

class ManagedExecutionEnv extends NodeExecutionEnv {
  readonly platform: NodeJS.Platform;
  readonly #explicitShellPath: string | undefined;
  readonly #shellEnv: NodeJS.ProcessEnv | undefined;
  readonly #watch: NodeWatchOptions | undefined;
  readonly #execEnv: ExecutionEnv | undefined;
  #resolvedBash: Promise<BashShellConfig | undefined> | undefined;
  #wslDelegate: NodeExecutionEnv | undefined;

  constructor(options: ManagedExecutionEnvOptions) {
    super({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    });
    this.platform = options.platform ?? process.platform;
    this.#explicitShellPath = options.shellPath;
    this.#shellEnv = options.shellEnv;
    this.#watch = options.watch;
    this.#execEnv = options.execEnv;
  }

  #resolveBash(): Promise<BashShellConfig | undefined> {
    this.#resolvedBash ??= resolveBashShell({
      platform: this.platform,
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

    const effectiveCommand = normalizePosixBashCommand(command, this.platform).command;

    if (this.#execEnv !== undefined) {
      return this.#execEnv.exec(effectiveCommand, options, context);
    }

    if (this.#explicitShellPath !== undefined) {
      return super.exec(effectiveCommand, options, context);
    }

    const resolved = await this.#resolveBash();
    if (resolved === undefined) {
      if (this.platform === "win32") {
        return err(
          new ExecutionError(
            "shell_unavailable",
            "No bash shell found. Install Git for Windows or configure an explicit shellPath.",
          ),
        );
      }
      return super.exec(effectiveCommand, options, context);
    }

    if (resolved.commandTransport === "argv") {
      return super.exec([resolved.shell, ...resolved.args, effectiveCommand], options, context);
    }

    // Legacy WSL reads commands via stdin (-s), which argv execution cannot express.
    if (this.#wslDelegate === undefined) {
      this.#wslDelegate = new NodeExecutionEnv({
        cwd: this.cwd,
        shellPath: resolved.shell,
        ...(this.#shellEnv === undefined ? {} : { shellEnv: this.#shellEnv }),
        ...(this.#watch === undefined ? {} : { watch: this.#watch }),
      });
    } else {
      this.#wslDelegate.cwd = this.cwd;
    }

    return this.#wslDelegate.exec(effectiveCommand, options, context);
  }

  override async cleanup(context: Context): Promise<void> {
    await super.cleanup(context);
    await this.#wslDelegate?.cleanup(context);
    await this.#execEnv?.cleanup(context);
  }
}

export function createManagedExecutionEnv(
  options: ManagedExecutionEnvOptions,
): NodeExecutionEnv & { readonly platform: NodeJS.Platform } {
  return new ManagedExecutionEnv(options);
}
