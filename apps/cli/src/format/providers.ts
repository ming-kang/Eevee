import type {
  ConnectionNote,
  ListModelsResponse,
  ListProvidersResponse,
  ModelDetail,
  ModelProfilesDocument,
  ModelsConfigDiagnostic,
  ProbeProviderResponse,
  ProviderCatalogResponse,
  ProviderDetail,
  ProviderSummary,
  RefreshModelsResponse,
  ReloadModelsResponse,
  SmokeTestModelResponse,
} from "@eevee/protocol";
import { tabular } from "./settings.ts";

const defined = (items: readonly (string | false | undefined)[]): string[] =>
  items.filter((item): item is string => Boolean(item));

function appendDiagnostics(
  lines: string[],
  diagnostics: readonly ModelsConfigDiagnostic[] | undefined,
): string {
  if (diagnostics === undefined || diagnostics.length === 0) return lines.join("\n");
  const formatted = diagnostics.map((d) => {
    const pos =
      d.line === undefined ? "" : `:${d.line}${d.column === undefined ? "" : `:${d.column}`}`;
    return `- ${d.path}${pos}: ${d.message}`;
  });
  return [...lines, "", "models.json diagnostics:", ...formatted].join("\n");
}

function providerAuthMethodsLabel(provider: {
  readonly authMethods: { readonly apiKey: boolean; readonly oauth: boolean };
}): string {
  return defined([
    provider.authMethods.apiKey && "api_key",
    provider.authMethods.oauth && "oauth",
  ]).join(", ");
}

function providerKindLabel(provider: {
  readonly kind?: "builtin" | "custom";
  readonly hasConfigOverride?: boolean;
}): string {
  const kind = provider.kind ?? "-";
  return kind === "builtin" && provider.hasConfigOverride === true ? "builtin+override" : kind;
}

function providerStatusLabel(provider: {
  readonly configured: boolean;
  readonly authType?: string;
  readonly authSource?: string;
}): string {
  return provider.configured
    ? `configured (${provider.authType ?? "unknown"}${provider.authSource ? `: ${provider.authSource}` : ""})`
    : "unconfigured";
}

function formatProviderSummaryRow(provider: ProviderSummary): string[] {
  return defined([
    provider.id,
    provider.name,
    providerKindLabel(provider),
    providerStatusLabel(provider),
    provider.api !== undefined && `api=${provider.api}`,
    `models=${provider.modelCount}`,
    (provider.customModelCount ?? 0) > 0 && `custom=${provider.customModelCount}`,
    (provider.overrideCount ?? 0) > 0 && `overrides=${provider.overrideCount}`,
    provider.authPreview !== undefined && `auth=${provider.authPreview}`,
    `methods=[${providerAuthMethodsLabel(provider)}]`,
  ]);
}

export function formatProviders(response: ListProvidersResponse): string {
  const lines =
    response.providers.length === 0
      ? ["No providers."]
      : [tabular(response.providers.map(formatProviderSummaryRow))];
  return appendDiagnostics(lines, response.diagnostics);
}

export function formatModels(response: ListModelsResponse): string {
  if (response.models.length === 0) return "No models.";
  return tabular(
    response.models.map((model) =>
      defined([
        `${model.provider}/${model.id}`,
        model.name,
        model.api,
        `reasoning=${model.reasoning}`,
        `ctx=${model.contextWindow}`,
        `available=${model.available}`,
        model.supportedThinkingLevels !== undefined &&
          `thinking=[${model.supportedThinkingLevels.join(",")}]`,
        model.isCustom === true && "custom",
        model.hasOverride === true && "override",
      ]),
    ),
  );
}

export function formatProviderCatalog(response: ProviderCatalogResponse): string {
  const lines = [`Supported APIs: ${response.supportedApis.join(", ")}`];
  if (response.providers.length === 0) {
    lines.push("No builtin providers.");
    return lines.join("\n");
  }
  lines.push(
    "",
    "Builtin providers:",
    tabular(
      response.providers.map((provider) =>
        defined([
          provider.id,
          provider.name,
          `apis=[${provider.apis.join(",")}]`,
          provider.baseUrl !== undefined && `url=${provider.baseUrl}`,
          `models=${provider.modelCount}`,
          provider.configured ? "configured" : "unconfigured",
          provider.hasConfigOverride && "override",
          `methods=[${providerAuthMethodsLabel(provider)}]`,
        ]),
      ),
    ),
  );
  return lines.join("\n");
}

function formatConnectionNoteLine(note: ConnectionNote): string {
  return note.warning === true
    ? `Connection: ${note.text} (warning: possible doubled /v1 — check the base URL)`
    : `Connection: ${note.text}`;
}

function formatModelDetailRow(model: ModelDetail): string[] {
  return defined([
    `- ${model.id}`,
    model.name,
    model.api,
    `reasoning=${model.reasoning}`,
    `ctx=${model.contextWindow}`,
    `max=${model.maxTokens}`,
    `available=${model.available}`,
    `thinking=[${model.supportedThinkingLevels.join(",")}]`,
    model.input.length > 0 && `input=[${model.input.join(",")}]`,
    model.isCustom && "custom",
    model.hasOverride && "override",
  ]);
}

export function formatProviderDetail(provider: ProviderDetail): string {
  const lines = [
    `${provider.id}\t${provider.name}\t${providerKindLabel(provider)}\t${providerStatusLabel(provider)}`,
    `API: ${provider.api ?? "-"}`,
    `Base URL: ${provider.baseUrl ?? "-"}`,
  ];
  if (provider.connectionNote !== undefined) {
    lines.push(formatConnectionNoteLine(provider.connectionNote));
  }

  const authSegments = defined([
    provider.authType !== undefined && `type=${provider.authType}`,
    provider.authSource !== undefined && `source=${provider.authSource}`,
    provider.authPreview !== undefined && `key=${provider.authPreview}`,
    provider.authAccountLabel !== undefined && `account=${provider.authAccountLabel}`,
    provider.authExpiresAt !== undefined &&
      `expires=${new Date(provider.authExpiresAt).toISOString()}`,
  ]);
  lines.push(
    `Auth: ${authSegments.length === 0 ? (provider.configured ? "configured" : "unconfigured") : authSegments.join(" ")}`,
  );

  if (provider.config !== undefined) {
    const headers =
      provider.config.headers === undefined
        ? []
        : Object.entries(provider.config.headers).map(([k, v]) => `${k}=${v}`);
    const configParts = defined([
      provider.config.authHeader === true && "authHeader=true",
      provider.config.hasApiKey === true && "apiKey=set",
      provider.config.apiKeyRef !== undefined && `apiKeyRef=${provider.config.apiKeyRef}`,
      provider.config.oauth !== undefined && `oauth=${provider.config.oauth}`,
      headers.length > 0 && `headers=[${headers.join(", ")}]`,
    ]);
    if (configParts.length > 0) lines.push(`Config: ${configParts.join(" ")}`);
  }

  if (provider.models.length === 0) {
    lines.push("Models: none");
  } else {
    const counts = defined([
      (provider.customModelCount ?? 0) > 0 && `${provider.customModelCount} custom`,
      (provider.overrideCount ?? 0) > 0 && `${provider.overrideCount} override(s)`,
    ]);
    const suffix = counts.length === 0 ? "" : `, ${counts.join(", ")}`;
    lines.push(
      `Models (${provider.models.length}${suffix}):`,
      tabular(provider.models.map(formatModelDetailRow)),
    );
  }
  return lines.join("\n");
}

export function formatProbeResult(result: ProbeProviderResponse): string {
  const newCount = result.models.filter((model) => !model.exists).length;
  const lines = [
    result.ok
      ? `Probe succeeded: ${result.models.length} model(s) discovered, ${newCount} new${result.truncated ? ", truncated" : ""}`
      : `Probe failed: ${result.error ?? "unknown error"}`,
  ];
  if (result.catalogUrl !== undefined) lines.push(`Catalog URL: ${result.catalogUrl}`);
  if (result.connectionNote !== undefined) {
    lines.push(formatConnectionNoteLine(result.connectionNote));
  }
  if (result.models.length > 0) {
    lines.push(
      tabular(
        result.models.map((model) =>
          defined([
            `- ${model.id}`,
            model.name,
            model.contextWindow !== undefined && `ctx=${model.contextWindow}`,
            model.maxTokens !== undefined && `max=${model.maxTokens}`,
            model.input !== undefined && `input=[${model.input.join(",")}]`,
            model.reasoning !== undefined && `reasoning=${model.reasoning}`,
            model.exists ? "exists" : "new",
          ]),
        ),
      ),
    );
  }
  return lines.join("\n");
}

export function formatSmokeTestResult(result: SmokeTestModelResponse): string {
  const parts = defined([
    `total=${result.totalMs}ms`,
    result.ttftMs !== undefined && `ttft=${result.ttftMs}ms`,
    `reasoning=${result.sawReasoning ? "yes" : "no"}`,
    `toolCall=${result.sawToolCall ? "yes" : "no"}`,
    result.usage !== undefined &&
      `tokens in=${result.usage.input} out=${result.usage.output} total=${result.usage.totalTokens}`,
  ]);
  const lines = [`Smoke test ${result.ok ? "passed" : "failed"} (${parts.join(", ")})`];
  if (result.error !== undefined) lines.push(`Error: ${result.error}`);
  if (result.replyPreview.length > 0) lines.push(`Reply: ${result.replyPreview}`);
  return lines.join("\n");
}

export function formatReloadModels(response: ReloadModelsResponse): string {
  return appendDiagnostics(
    [
      `Reloaded models.json: ${response.providerCount} provider(s), ${response.modelCount} model(s)`,
    ],
    response.diagnostics,
  );
}

export function formatRefreshModels(response: RefreshModelsResponse): string {
  const entries = Object.entries(response.errors);
  if (entries.length === 0) return "Refreshed models.";
  return [
    "Refreshed models with errors:",
    ...entries.map(([providerId, message]) => `- ${providerId}: ${message}`),
  ].join("\n");
}

export function formatModelProfiles(doc: ModelProfilesDocument): string {
  const lines =
    doc.profiles.length === 0
      ? ["No model profiles configured."]
      : [
          tabular(
            doc.profiles.map((p) => [
              p.id,
              `${p.model.provider}/${p.model.modelId}${p.model.thinkingLevel === undefined ? "" : ` (${p.model.thinkingLevel})`}`,
              p.description,
            ]),
          ),
        ];
  if (doc.notes !== undefined && doc.notes.trim().length > 0) {
    lines.push("", `Notes: ${doc.notes}`);
  }
  return lines.join("\n");
}
