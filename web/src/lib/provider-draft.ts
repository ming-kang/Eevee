/**
 * The provider editor's form, and how it maps to a models.json entry. The form holds what it shows as text;
 * everything else an entry carries (`modelOverrides`, a model's `promptCache` or own endpoint) travels through
 * untouched.
 */
import type {
  BuiltinModelView,
  ProbedModelView,
  ProviderConfigView,
  ProviderModelConfig,
} from "@shared/api/contract.ts";
import { fromRows, type KeyValueRow, parseAmount, parseTokenCount, toRows } from "./fields.ts";

/**
 * The chat APIs a custom provider can speak. The three custom endpoints speak come first, the two in widest use
 * ahead of Chat Completions.
 */
export const API_TYPES = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
  "azure-openai-responses",
  "mistral-conversations",
  "google-vertex",
  "bedrock-converse-stream",
  "pi-messages",
] as const;

/** The route an API calls, which is how an endpoint's own docs name its protocol. */
export const API_ENDPOINT: Readonly<Record<string, string>> = {
  "anthropic-messages": "Anthropic /v1/messages",
  "openai-responses": "OpenAI /v1/responses",
  "openai-completions": "OpenAI /v1/chat/completions",
};

/** What each client appends to the baseUrl; APIs with other URL rules are absent. */
const REQUEST_PATHS: Readonly<Record<string, string>> = {
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/responses",
  "openai-completions": "/chat/completions",
  "mistral-conversations": "/v1/chat/completions",
};

/** How an API wants its baseUrl: with the version path, or the bare origin. */
type BaseUrlShape = "versioned" | "v1beta" | "origin";

export function baseUrlShape(api: string | undefined): BaseUrlShape | undefined {
  switch (api) {
    case "openai-responses":
    case "openai-completions":
    case "azure-openai-responses":
      return "versioned";
    case "google-generative-ai":
      return "v1beta";
    case "anthropic-messages":
    case "mistral-conversations":
      return "origin";
    default:
      return undefined;
  }
}

export function baseUrlPlaceholder(api: string | undefined): string {
  const shape = baseUrlShape(api);
  if (shape === "origin") return "https://api.example.com";
  if (shape === "v1beta") return "https://api.example.com/v1beta";
  return "https://api.example.com/v1";
}

/**
 * Where requests for this API and baseUrl go, so a wrong shape shows as a wrong address instead of a 404 at the
 * first message; `doubled` when the client's `/v1` would repeat the baseUrl's.
 */
export function requestTarget(
  api: string | undefined,
  baseUrl: string,
): { url: string; doubled: boolean } | undefined {
  const suffix = api === undefined ? undefined : REQUEST_PATHS[api];
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (suffix === undefined || base === "" || base.includes("?") || !/^https?:\/\//i.test(base)) {
    return undefined;
  }
  return { url: `${base}${suffix}`, doubled: suffix.startsWith("/v1/") && /\/v1$/i.test(base) };
}

export type ModelDraft = {
  /** Stable while the id is being typed. */
  key: string;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  image: boolean;
  cost: { input: string; output: string; cacheRead: string; cacheWrite: string };
  /** The entry as written, for the fields the form does not show. */
  original?: ProviderModelConfig;
};

export type ProviderDraft = {
  name: string;
  api: string;
  baseUrl: string;
  /** models.json's `apiKey`, usually an environment variable reference. */
  apiKey: string;
  headers: KeyValueRow[];
  authHeader: boolean;
  models: ModelDraft[];
};

export type DraftError =
  | { code: "model_id"; index: number }
  | { code: "duplicate_model"; id: string }
  | { code: "tokens"; model: string; field: "contextWindow" | "maxTokens" }
  | { code: "price"; model: string };

let nextKey = 0;
const newKey = () => `m${++nextKey}`;

const text = (value: number | undefined) => (value === undefined ? "" : String(value));

export function toModelDraft(
  model: ProviderModelConfig | ProbedModelView,
  original?: ProviderModelConfig,
): ModelDraft {
  const cost = original?.cost;
  return {
    key: newKey(),
    id: model.id,
    name: model.name ?? "",
    contextWindow: text(model.contextWindow),
    maxTokens: text(model.maxTokens),
    reasoning: model.reasoning === true,
    image: model.input?.includes("image") ?? false,
    cost: {
      input: text(cost?.input),
      output: text(cost?.output),
      cacheRead: text(cost?.cacheRead),
      cacheWrite: text(cost?.cacheWrite),
    },
    ...(original === undefined ? {} : { original }),
  };
}

export function emptyModelDraft(): ModelDraft {
  return toModelDraft({ id: "" });
}

export function toDraft(config: ProviderConfigView | undefined): ProviderDraft {
  return {
    name: config?.name ?? "",
    api: config?.api ?? "",
    baseUrl: config?.baseUrl ?? "",
    apiKey: config?.apiKey ?? "",
    headers: toRows(config?.headers),
    authHeader: config?.authHeader === true,
    models: (config?.models ?? []).map((model) => toModelDraft(model, model)),
  };
}

function setOrDrop<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

const trimmed = (value: string) => (value.trim() === "" ? undefined : value.trim());

function modelFromDraft(draft: ModelDraft): ProviderModelConfig | DraftError {
  const id = draft.id.trim();
  const model: ProviderModelConfig = { ...draft.original, id };
  setOrDrop(model, "name", trimmed(draft.name));
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const value = parseTokenCount(draft[field]);
    if (Number.isNaN(value)) return { code: "tokens", model: id, field };
    setOrDrop(model, field, value);
  }
  // Leaving a flag off writes nothing, unless the entry already said so: off is the default.
  setOrDrop(
    model,
    "reasoning",
    draft.reasoning ? true : draft.original?.reasoning === undefined ? undefined : false,
  );
  setOrDrop(
    model,
    "input",
    draft.image ? ["text", "image"] : draft.original?.input === undefined ? undefined : ["text"],
  );
  const cost: NonNullable<ProviderModelConfig["cost"]> = {};
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = parseAmount(draft.cost[field]);
    if (Number.isNaN(value)) return { code: "price", model: id };
    if (value !== undefined) cost[field] = value;
  }
  setOrDrop(model, "cost", Object.keys(cost).length === 0 ? undefined : cost);
  return model;
}

/** The entry the form makes, keeping what the form does not show; or the first value that cannot be written. */
export function fromDraft(
  draft: ProviderDraft,
  original: ProviderConfigView | undefined,
): { config: ProviderConfigView } | { error: DraftError } {
  const config: ProviderConfigView = { ...original };
  setOrDrop(config, "name", trimmed(draft.name));
  setOrDrop(config, "api", trimmed(draft.api));
  setOrDrop(config, "baseUrl", trimmed(draft.baseUrl));
  setOrDrop(config, "apiKey", trimmed(draft.apiKey));
  setOrDrop(config, "headers", fromRows(draft.headers));
  setOrDrop(config, "authHeader", draft.authHeader ? true : undefined);
  const models: ProviderModelConfig[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of draft.models.entries()) {
    if (entry.id.trim() === "") return { error: { code: "model_id", index } };
    const model = modelFromDraft(entry);
    if ("code" in model) return { error: model };
    if (seen.has(model.id)) return { error: { code: "duplicate_model", id: model.id } };
    seen.add(model.id);
    models.push(model);
  }
  setOrDrop(config, "models", models.length === 0 ? undefined : models);
  return { config };
}

/** Adds the picked catalog models the form does not have yet, keeping the order they were listed in. */
export function addProbed(draft: ProviderDraft, picked: readonly ProbedModelView[]): number {
  const have = new Set(draft.models.map((m) => m.id.trim()));
  const fresh = picked.filter((m) => !have.has(m.id));
  draft.models.push(...fresh.map((model) => toModelDraft(model)));
  return fresh.length;
}

/** Provider ids go into URLs and `provider/model` references: no spaces, slashes or leading punctuation. */
export function isProviderId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** The model fields a built-in model can fill in. Its id, API and endpoint stay the model's own. */
const REFERENCE_FIELDS = [
  "name",
  "reasoning",
  "image",
  "contextWindow",
  "maxTokens",
  "cost",
] as const;
export type ReferenceField = (typeof REFERENCE_FIELDS)[number];

type ReferenceChange = {
  field: ReferenceField;
  /** The model already has the reference's value; nothing to copy. */
  same: boolean;
  /** Checked to begin with: the fields the model leaves unset. Prices never are; a gateway's rarely match. */
  checked: boolean;
};

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export function referenceChanges(
  model: ModelDraft,
  reference: BuiltinModelView,
): ReferenceChange[] {
  const name = model.name.trim();
  const image = reference.input.includes("image");
  const rows: [ReferenceField, same: boolean, unset: boolean][] = [
    // An unset name falls back to the id, so a reference named like the id is no change.
    ["name", (name || model.id.trim()) === reference.name, name === ""],
    ["reasoning", model.reasoning === reference.reasoning, !model.reasoning],
    ["image", model.image === image, !model.image],
    [
      "contextWindow",
      parseTokenCount(model.contextWindow) === reference.contextWindow,
      model.contextWindow.trim() === "",
    ],
    [
      "maxTokens",
      parseTokenCount(model.maxTokens) === reference.maxTokens,
      model.maxTokens.trim() === "",
    ],
    [
      "cost",
      COST_FIELDS.every((f) => (parseAmount(model.cost[f]) ?? 0) === reference.cost[f]),
      false,
    ],
  ];
  return rows.map(([field, same, unset]) => ({ field, same, checked: !same && unset }));
}

/** Copies `fields` of the built-in `reference` into the form; token counts go in exact. */
export function applyReference(
  model: ModelDraft,
  reference: BuiltinModelView,
  fields: Iterable<ReferenceField>,
): void {
  for (const field of fields) {
    if (field === "name") model.name = reference.name;
    else if (field === "reasoning") model.reasoning = reference.reasoning;
    else if (field === "image") model.image = reference.input.includes("image");
    else if (field === "cost") {
      for (const f of COST_FIELDS) model.cost[f] = String(reference.cost[f]);
    } else model[field] = String(reference[field]);
  }
}
