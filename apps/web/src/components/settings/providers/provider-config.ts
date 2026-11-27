import type { ProviderDetail, UpsertProviderRequest } from "@eevee/protocol";
import { t } from "../../../lib/i18n.ts";
import { deepEqualJson } from "../../../lib/object.ts";
import { type HeaderRow, headersToRows, rowsToHeaders } from "../header-rows.ts";
import { validateBaseUrl } from "../provider-utils.ts";

export type ProviderConfigDraft = {
  readonly name: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly authHeader: boolean;
  readonly headers: HeaderRow[];
  readonly apiKey: string;
  readonly apiKeyTouched: boolean;
  readonly clearApiKey: boolean;
  readonly revealApiKey: boolean;
};

export function createProviderConfigDraft(detail: ProviderDetail): ProviderConfigDraft {
  return {
    name: detail.config?.name ?? "",
    api: detail.config?.api ?? "",
    baseUrl: detail.config?.baseUrl ?? "",
    authHeader: detail.config?.authHeader ?? false,
    headers: headersToRows(detail.config?.headers),
    apiKey: detail.config?.apiKeyRef ?? "",
    apiKeyTouched: false,
    clearApiKey: false,
    revealApiKey: false,
  };
}

export function buildProviderPatch(
  detail: ProviderDetail,
  draft: ProviderConfigDraft,
): UpsertProviderRequest {
  const patch: UpsertProviderRequest = {};
  const trimmedName = draft.name.trim();
  if (trimmedName !== (detail.config?.name ?? "")) {
    patch.name = trimmedName ? trimmedName : null;
  }
  const trimmedApi = draft.api.trim();
  if (trimmedApi !== (detail.config?.api ?? "")) {
    patch.api = trimmedApi ? trimmedApi : null;
  }
  const trimmedBaseUrl = draft.baseUrl.trim();
  if (trimmedBaseUrl) {
    const baseErr = validateBaseUrl(trimmedBaseUrl);
    if (baseErr) throw new Error(baseErr);
  }
  if (trimmedBaseUrl !== (detail.config?.baseUrl ?? "")) {
    patch.baseUrl = trimmedBaseUrl ? trimmedBaseUrl : null;
  }
  if (draft.authHeader !== (detail.config?.authHeader ?? false)) {
    patch.authHeader = draft.authHeader ? true : null;
  }
  const nextHeaders = rowsToHeaders(draft.headers, t("providers.providerHeadersLabel"));
  if (!deepEqualJson(nextHeaders, detail.config?.headers)) {
    patch.headers = nextHeaders ?? null;
  }
  if (draft.clearApiKey) {
    patch.apiKey = null;
  } else if (draft.apiKeyTouched) {
    const trimmedKey = draft.apiKey.trim();
    if (trimmedKey) patch.apiKey = trimmedKey;
    else if (detail.config?.apiKeyRef !== undefined) patch.apiKey = null;
  }
  return patch;
}
