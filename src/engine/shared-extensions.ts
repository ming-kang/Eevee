import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { McpServerView, UserExtensionView } from "../api/contract.ts";
import type { ConfigProblem } from "../contracts/index.ts";
import { McpHub, type McpHubOptions } from "../extensions/mcp/index.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { loadUserExtensions } from "./user-extensions.ts";

export type SharedExtensionsOptions = {
  paths: EeveePaths;
  client: { name: string; version: string };
  /** Called whenever the list of extensions or one of them changes. */
  onChange(): void;
  /** Opens an MCP server's transport; tests pass an in-memory one. */
  openMcp?: McpHubOptions["open"];
};

/**
 * Extensions every project installs on top of Eevee's own: Durable's `tool-search` and `codemode`, one per MCP
 * server, and the user's. Roles bring `tool-search` and `codemode` along when their tools need them, and enable
 * the others by name in settings.json.
 */
export class SharedExtensions {
  readonly #toolSearch = createToolSearchExtension();
  readonly #sandbox = new CodemodeSandbox();
  readonly #hub: McpHub;
  readonly #onChange: () => void;
  #codemode: Extension;
  #user: Extension[] = [];
  #userStatus: UserExtensionView[] = [];

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

  /** Loads the user's extensions and starts connecting MCP servers, without waiting for them. */
  static async open(options: SharedExtensionsOptions): Promise<SharedExtensions> {
    const shared = new SharedExtensions(options);
    const { extensions, status } = await loadUserExtensions(options.paths.extensions);
    shared.#user = extensions;
    shared.#userStatus = status;
    await shared.#hub.start();
    return shared;
  }

  list(): Extension[] {
    return [this.#toolSearch, this.#codemode, ...this.#hub.extensions(), ...this.#user];
  }

  mcpServers(): McpServerView[] {
    return this.#hub.status();
  }

  userExtensions(): UserExtensionView[] {
    return this.#userStatus;
  }

  problems(): readonly ConfigProblem[] {
    return this.#hub.problems();
  }

  /** Reads mcp.json again and reconnects every server. */
  reloadMcp(): Promise<void> {
    return this.#hub.reload();
  }

  /** mcp.json's server entries as written. */
  mcpEntries(): Promise<Record<string, unknown>> {
    return this.#hub.entries();
  }

  /** Changes one server's entry in mcp.json, or removes it, and reconnects that server. */
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
