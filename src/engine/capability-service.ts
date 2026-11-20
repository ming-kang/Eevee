import { ConfigError } from "../config/load.ts";
import type { RoleSettings, SettingsStore } from "../config/settings.ts";
import { ProblemError, ROLE_NAMES, type RoleName } from "../domain/index.ts";
import type { CapabilitiesView } from "../protocol/contract.ts";
import { mcpExtensionName } from "./extensions/mcp/index.ts";
import { roleExtensions } from "./roles/index.ts";
import type { SharedExtensions } from "./shared-extensions.ts";

type Deps = {
  shared: SharedExtensions;
  settings: SettingsStore;
  refreshProjects: () => Promise<void>;
};
async function mcpProblem<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ProblemError({ code: "bad_config", problems: error.problems });
    }
    if (error instanceof SyntaxError) {
      throw new ProblemError({
        code: "bad_config",
        problems: [{ file: "mcp.json", code: "failed", detail: error.message }],
      });
    }
    throw error;
  }
}

/** A change to one role's capabilities; `maxTurns: null` goes back to Durable's default. */
export type RoleCapabilityChange = { extensions?: readonly string[]; maxTurns?: number | null };

export class CapabilityService {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }
  view(): CapabilitiesView {
    const shared = this.#deps.shared;
    const settings = this.#deps.settings.current;
    return {
      available: shared.list().map((e) => ({ name: e.name, tools: e.tools?.length ?? 0 })),
      roles: ROLE_NAMES.map((role) => {
        const own: RoleSettings = settings.roles[role] ?? {};
        return {
          role,
          builtIn: roleExtensions(role),
          enabled: own.extensions ?? [],
          ...(own.maxTurns === undefined ? {} : { maxTurns: own.maxTurns }),
        };
      }),
      mcp: shared.mcpServers(),
      problems: shared.problems(),
    };
  }

  async setRole(role: RoleName, change: RoleCapabilityChange): Promise<CapabilitiesView> {
    if (change.extensions !== undefined) {
      const known = new Set(this.#deps.shared.list().map((e) => e.name));
      const enabled = this.#deps.settings.current.roles[role]?.extensions ?? [];
      const unknown = change.extensions.filter(
        (name) => !known.has(name) && !enabled.includes(name),
      );
      if (unknown.length > 0) throw new ProblemError({ code: "no_extension", names: unknown });
    }
    await this.#deps.settings.update((stored) => {
      const current = stored.roles?.[role] ?? {};
      const next: RoleSettings = { ...current };
      if (change.extensions !== undefined) next.extensions = [...new Set(change.extensions)];
      if (change.maxTurns === null) delete next.maxTurns;
      else if (change.maxTurns !== undefined) next.maxTurns = change.maxTurns;
      return { ...stored, roles: { ...stored.roles, [role]: next } };
    });
    await this.#deps.refreshProjects();
    return this.view();
  }

  async reloadMcp(): Promise<CapabilitiesView> {
    await this.#deps.shared.reloadMcp();
    return this.view();
  }

  mcpConfig(): Promise<Record<string, unknown>> {
    return mcpProblem(this.#deps.shared.mcpEntries());
  }

  async saveMcpServer(
    name: string,
    entry: Record<string, unknown> | undefined,
  ): Promise<CapabilitiesView> {
    await mcpProblem(this.#deps.shared.saveMcpServer(name, entry));
    if (entry === undefined) {
      const extension = mcpExtensionName(name);
      const enabling = ROLE_NAMES.filter((role) =>
        this.#deps.settings.current.roles[role]?.extensions?.includes(extension),
      );
      if (enabling.length > 0) {
        await this.#deps.settings.update((stored) => {
          const roles = { ...stored.roles };
          for (const role of enabling) {
            const own = roles[role] ?? {};
            roles[role] = {
              ...own,
              extensions: (own.extensions ?? []).filter((e) => e !== extension),
            };
          }
          return { ...stored, roles };
        });
        await this.#deps.refreshProjects();
      }
    }
    return this.view();
  }
}
