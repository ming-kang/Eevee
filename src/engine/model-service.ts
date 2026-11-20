import { processEnv, resolveConfigValue } from "../config/load.ts";
import type { ProviderConfig } from "../config/models.ts";
import type { SettingsStore } from "../config/settings.ts";
import { type ModelChoice, ProblemError, type RoleName } from "../domain/index.ts";
import type { ModelsView, ProbeModelsInput, ProjectSummary } from "../protocol/contract.ts";
import { readText } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { type BuiltinModelRef, matchBuiltinModels } from "./models/builtin-catalog.ts";
import { buildModelsView } from "./models/catalog.ts";
import type { ModelRuntime } from "./models/index.ts";
import { type ProbeResult, probeModels } from "./models/probe.ts";
import type { Project } from "./project/project.ts";
import type { ProjectRegistry } from "./project-registry.ts";

type Deps = {
  paths: EeveePaths;
  settings: SettingsStore;
  runtime: ModelRuntime;
  projects: Pick<ProjectRegistry, "list" | "applyModels">;
};
/** Provider ids go into URLs and `provider/model` references: no spaces, slashes or leading punctuation. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ModelService {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }
  async catalog(): Promise<ModelsView> {
    return buildModelsView({
      models: this.#deps.runtime.models(),
      defaults: this.#deps.settings.current.models,
      profiles: await readText(this.#deps.paths.modelProfiles),
      customProviders: this.#deps.runtime.customProviders(),
      builtinProviders: this.#deps.runtime.builtinProviders(),
      problems: this.#deps.runtime.problems(),
    });
  }

  providers(): Promise<Record<string, ProviderConfig>> {
    return this.#deps.runtime.providerConfigs();
  }

  async saveProvider(id: string, entry: ProviderConfig | undefined): Promise<ModelsView> {
    const runtime = this.#deps.runtime;
    const known = runtime.builtinProviders().has(id) || id in (await runtime.providerConfigs());
    if (!known && !PROVIDER_ID.test(id)) {
      throw new ProblemError({ code: "invalid", field: "provider" });
    }
    await runtime.setProviderConfig(id, entry, this.#modelsInUse(id));
    if (entry === undefined && !runtime.builtinProviders().has(id)) {
      await runtime.credentials.delete(id);
      await runtime.reload();
    }
    await this.#deps.projects.applyModels();
    return this.catalog();
  }

  builtin(query: string, api?: string): BuiltinModelRef[] {
    return matchBuiltinModels(this.#deps.runtime.builtinCatalog(), query, api);
  }

  async probe(input: ProbeModelsInput): Promise<ProbeResult> {
    const models = this.#deps.runtime.models();
    const saved =
      input.key === undefined && input.provider !== undefined
        ? await models.getAuth(input.provider).catch(() => undefined)
        : undefined;
    const key =
      input.key === undefined
        ? saved?.auth.apiKey
        : await resolveConfigValue(input.key, processEnv);
    const headers: Record<string, string | null> = { ...saved?.auth.headers };
    for (const [name, raw] of Object.entries(input.headers ?? {})) {
      const value = await resolveConfigValue(raw, processEnv);
      if (value !== undefined) headers[name] = value;
    }
    return probeModels({
      baseUrl: input.baseUrl,
      ...(input.api === undefined ? {} : { api: input.api }),
      auth: { ...(key === undefined ? {} : { apiKey: key }), headers },
    });
  }

  #modelsInUse(provider: string): string[] {
    const choices = [
      ...Object.values(this.#deps.settings.current.models),
      ...this.#deps.projects.list().flatMap((p) => Object.values(p.models ?? {})),
    ];
    return [
      ...new Set(choices.filter((c) => c?.provider === provider).map((c) => c?.modelId ?? "")),
    ];
  }

  async setDefault(role: RoleName | "default", choice: ModelChoice): Promise<void> {
    this.#requireModel(choice);
    await this.#deps.settings.update((stored) => ({
      ...stored,
      models: { ...stored.models, [role]: choice },
    }));
    await this.#deps.projects.applyModels();
  }

  async setProjectModel(
    host: Project,
    role: RoleName | "default",
    choice: ModelChoice | null,
  ): Promise<ProjectSummary> {
    if (choice !== null) this.#requireModel(choice);
    await host.setModel(role, choice);
    return host.summary();
  }

  #requireModel(choice: ModelChoice): void {
    if (this.#deps.runtime.models().getModel(choice.provider, choice.modelId) === undefined) {
      throw new ProblemError({ code: "no_model", ...choice });
    }
  }

  async login(provider: string, key: string): Promise<void> {
    if (this.#deps.runtime.models().getProvider(provider) === undefined) {
      throw new ProblemError({ code: "no_provider", provider });
    }
    await this.#deps.runtime.credentials.modify(provider, async () => ({
      type: "api_key",
      key,
    }));
    await this.#deps.runtime.reload();
  }

  async logout(provider: string): Promise<void> {
    await this.#deps.runtime.credentials.delete(provider);
    await this.#deps.runtime.reload();
  }
}
