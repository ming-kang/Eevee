import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { ConfigProblem } from "../domain/index.ts";
import type { McpServerView } from "../protocol/contract.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { McpHub, type McpHubOptions } from "./extensions/mcp/index.ts";

export type SharedExtensionsOptions = {
  paths: EeveePaths;
  client: { name: string; version: string };
  onChange(): void;
  /** Opens an MCP server's transport; tests pass an in-memory one. */
  openMcp?: McpHubOptions["open"];
};

/**
 * Extensions every project installs on top of Eevee's own: Durable's `tool-search` and `codemode`, one per MCP
 * server. Roles bring `tool-search` and `codemode` along when their tools need them, and enable the others by
 * name in settings.json.
 */
export class SharedExtensions {
  readonly #toolSearch = createToolSearchExtension();
  readonly #sandbox = new CodemodeSandbox();
  readonly #hub: McpHub;
  readonly #onChange: () => void;
  #codemode: Extension;

  private constructor(options: SharedExtensionsOptions) {
    this.#onChange = options.onChange;
    this.#codemode = this.#buildCodemode([]);
    this.#hub = new McpHub({
      configPath: options.paths.mcp,
      outputDir: options.paths.runtime.mcpOutput,
      client: options.client,
      onChange: () => {
        this.#codemode = this.#buildCodemode(this.#hub.namespaces());
        this.#onChange();
      },
      ...(options.openMcp === undefined ? {} : { open: options.openMcp }),
    });
  }

  /** Starts connecting MCP servers, without waiting for them. */
  static async open(options: SharedExtensionsOptions): Promise<SharedExtensions> {
    const shared = new SharedExtensions(options);
    await shared.#hub.start();
    return shared;
  }

  list(): Extension[] {
    return [this.#toolSearch, this.#codemode, ...this.#hub.extensions()];
  }

  mcpServers(): McpServerView[] {
    return this.#hub.status();
  }

  problems(): readonly ConfigProblem[] {
    return this.#hub.problems();
  }

  reloadMcp(): Promise<void> {
    return this.#hub.reload();
  }

  mcpEntries(): Promise<Record<string, unknown>> {
    return this.#hub.entries();
  }

  saveMcpServer(name: string, entry: Record<string, unknown> | undefined): Promise<void> {
    return this.#hub.save(name, entry);
  }

  async close(): Promise<void> {
    await this.#hub.close();
    await this.#sandbox.close();
  }

  #buildCodemode(namespaces: ReturnType<McpHub["namespaces"]>): Extension {
    return createCodemodeExtension({ sandbox: this.#sandbox, namespaces });
  }
}
