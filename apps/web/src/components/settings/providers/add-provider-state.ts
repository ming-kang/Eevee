import type {
  ProbedModel,
  ProbeProviderRequest,
  ProviderCatalogResponse,
  UpsertProviderRequest,
} from "@eevee/protocol";
import { t } from "../../../lib/i18n.ts";
import { type HeaderRow, rowsToHeaders } from "../header-rows.ts";
import { toImportModelPayload, validateBaseUrl } from "../provider-utils.ts";

export type AddProviderMode = "builtin" | "custom";

export type BuiltinProviderDraft = {
  readonly filter: string;
  readonly selectedId: string | undefined;
  readonly apiKey: string;
  readonly revealKey: boolean;
  readonly baseUrl: string;
  readonly headers: HeaderRow[];
};

export type CustomProviderDraft = {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly revealKey: boolean;
  readonly authHeader: boolean;
  readonly headers: HeaderRow[];
};

export type ProbeModelsDraft = {
  readonly probing: boolean;
  readonly error: string | undefined;
  readonly catalogUrl: string | undefined;
  readonly truncated: boolean;
  readonly models: readonly ProbedModel[];
  readonly selected: Record<string, boolean>;
  readonly filter: string;
};

export type AddProviderState = {
  readonly mode: AddProviderMode;
  readonly error: string | undefined;
  readonly saving: boolean;
  readonly builtin: BuiltinProviderDraft;
  readonly custom: CustomProviderDraft;
  readonly probe: ProbeModelsDraft;
};

export type AddProviderAction =
  | { readonly type: "setMode"; readonly mode: AddProviderMode }
  | { readonly type: "setError"; readonly error: string | undefined }
  | { readonly type: "setSaving"; readonly saving: boolean }
  | { readonly type: "patchBuiltin"; readonly patch: Partial<BuiltinProviderDraft> }
  | { readonly type: "selectBuiltin"; readonly id: string }
  | { readonly type: "patchCustom"; readonly patch: Partial<CustomProviderDraft> }
  | { readonly type: "patchProbe"; readonly patch: Partial<ProbeModelsDraft> }
  | { readonly type: "syncCatalog"; readonly catalog: ProviderCatalogResponse }
  | { readonly type: "startProbe" }
  | {
      readonly type: "finishProbe";
      readonly catalogUrl: string | undefined;
      readonly truncated: boolean;
      readonly models: readonly ProbedModel[];
      readonly error: string | undefined;
    }
  | { readonly type: "failProbe"; readonly error: string };

export function resolveCustomApi(supportedApis: readonly string[], current?: string): string {
  if (current && supportedApis.includes(current)) return current;
  if (supportedApis.includes("openai-completions")) return "openai-completions";
  return supportedApis[0] ?? current ?? "openai-completions";
}

export function createAddProviderState(
  initialCatalog: ProviderCatalogResponse | undefined,
): AddProviderState {
  return {
    mode: "builtin",
    error: undefined,
    saving: false,
    builtin: {
      filter: "",
      selectedId: initialCatalog?.providers[0]?.id,
      apiKey: "",
      revealKey: false,
      baseUrl: "",
      headers: [],
    },
    custom: {
      id: "",
      name: "",
      api: resolveCustomApi(initialCatalog?.supportedApis ?? []),
      baseUrl: "",
      apiKey: "",
      revealKey: false,
      authHeader: false,
      headers: [],
    },
    probe: {
      probing: false,
      error: undefined,
      catalogUrl: undefined,
      truncated: false,
      models: [],
      selected: {},
      filter: "",
    },
  };
}

export function addProviderReducer(
  state: AddProviderState,
  action: AddProviderAction,
): AddProviderState {
  switch (action.type) {
    case "setMode":
      return { ...state, mode: action.mode, error: undefined };
    case "setError":
      return { ...state, error: action.error };
    case "setSaving":
      return { ...state, saving: action.saving };
    case "patchBuiltin":
      return { ...state, builtin: { ...state.builtin, ...action.patch } };
    case "selectBuiltin":
      return {
        ...state,
        error: undefined,
        builtin: { ...state.builtin, selectedId: action.id, apiKey: "", baseUrl: "", headers: [] },
      };
    case "patchCustom":
      return { ...state, custom: { ...state.custom, ...action.patch } };
    case "patchProbe":
      return { ...state, probe: { ...state.probe, ...action.patch } };
    case "syncCatalog":
      return {
        ...state,
        builtin: {
          ...state.builtin,
          selectedId: state.builtin.selectedId ?? action.catalog.providers[0]?.id,
        },
        custom: {
          ...state.custom,
          api: resolveCustomApi(action.catalog.supportedApis, state.custom.api),
        },
      };
    case "startProbe":
      return {
        ...state,
        error: undefined,
        probe: { ...state.probe, probing: true, error: undefined },
      };
    case "finishProbe": {
      const autoCheck = action.models.length <= 20;
      return {
        ...state,
        probe: {
          ...state.probe,
          probing: false,
          catalogUrl: action.catalogUrl,
          truncated: action.truncated,
          models: action.models,
          error: action.error,
          selected: Object.fromEntries(action.models.map((model) => [model.id, autoCheck])),
        },
      };
    }
    case "failProbe":
      return {
        ...state,
        probe: {
          ...state.probe,
          probing: false,
          error: action.error,
          models: [],
        },
      };
  }
}

export function buildBuiltinOverrideRequest(
  builtin: BuiltinProviderDraft,
): UpsertProviderRequest | undefined {
  const trimmedBaseUrl = builtin.baseUrl.trim();
  if (trimmedBaseUrl) {
    const baseErr = validateBaseUrl(trimmedBaseUrl);
    if (baseErr) throw new Error(baseErr);
  }
  const headers = rowsToHeaders(builtin.headers, t("providers.gatewayHeadersLabel"));
  if (!trimmedBaseUrl && !headers) return undefined;
  return {
    ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
    ...(headers ? { headers } : {}),
  };
}

export function buildDraftProbeRequest(custom: CustomProviderDraft): ProbeProviderRequest {
  const trimmedBaseUrl = custom.baseUrl.trim();
  const baseErr = validateBaseUrl(trimmedBaseUrl);
  if (baseErr) throw new Error(baseErr);
  const headers = rowsToHeaders(custom.headers, t("providers.customHeadersLabel"));
  const trimmedKey = custom.apiKey.trim();
  return {
    baseUrl: trimmedBaseUrl,
    api: custom.api,
    ...(trimmedKey ? { apiKey: trimmedKey } : {}),
    ...(headers ? { headers } : {}),
    ...(custom.authHeader ? { authHeader: true } : {}),
  };
}

export function buildCustomProviderRequest(
  custom: CustomProviderDraft,
  selectedModels: readonly ProbedModel[],
): UpsertProviderRequest {
  const id = custom.id.trim();
  if (!id) throw new Error(t("providers.error.emptyId"));
  const trimmedBaseUrl = custom.baseUrl.trim();
  const baseErr = validateBaseUrl(trimmedBaseUrl);
  if (baseErr) throw new Error(baseErr);
  if (!custom.api) throw new Error(t("providers.error.missingApi"));
  const headers = rowsToHeaders(custom.headers, t("providers.customHeadersLabel"));
  const trimmedName = custom.name.trim();
  const trimmedKey = custom.apiKey.trim();
  return {
    id,
    ...(trimmedName ? { name: trimmedName } : {}),
    api: custom.api,
    baseUrl: trimmedBaseUrl,
    ...(trimmedKey ? { apiKey: trimmedKey } : {}),
    ...(custom.authHeader ? { authHeader: true } : {}),
    ...(headers ? { headers } : {}),
    ...(selectedModels.length > 0 ? { models: selectedModels.map(toImportModelPayload) } : {}),
  };
}
