/**
 * `models.json`'s schema: custom providers and models, and changes to built-in ones. The format follows pi's
 * coding agent (`packages/coding-agent/docs/models-configuration.md`), a subset of it:
 *
 * ```json
 * {
 *   "providers": {
 *     "local": {
 *       "baseUrl": "http://127.0.0.1:11434/v1",
 *       "api": "openai-completions",
 *       "apiKey": "ollama",
 *       "models": [{ "id": "qwen3", "contextWindow": 32768 }]
 *     },
 *     "anthropic": { "modelOverrides": { "claude-opus-4-7": { "contextWindow": 500000 } } }
 *   }
 * }
 * ```
 *
 * A built-in provider id changes that provider; any other id adds one, which needs `baseUrl` and `api`.
 * `apiKey` and `headers` values may reference environment variables (`$NAME`, `${NAME}`); a key stored in
 * `auth.json` wins over `apiKey`. `modelOverrides` changes fields of existing models, merging `cost` and
 * `promptCache` field by field.
 *
 * This is the configuration's contract, apart from the IO that reads and applies it (`src/models/`): the Engine
 * validates with these schemas, and the Engine, the HTTP API and the panel all take their types from them.
 */
import { arr, bool, map, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

const Headers = map(str());
const Positive = num({ exclusiveMinimum: 0 });

const overrideFields = {
  name: opt(str({ minLength: 1 })),
  reasoning: opt(bool()),
  input: opt(arr(oneOf(["text", "image"]))),
  contextWindow: opt(Positive),
  maxTokens: opt(Positive),
  cost: opt(
    obj({
      input: opt(num()),
      output: opt(num()),
      cacheRead: opt(num()),
      cacheWrite: opt(num()),
    }),
  ),
  promptCache: opt(obj({ short: opt(num()), long: opt(num()) })),
  headers: opt(Headers),
};

/** One model entry of a provider, as written. */
export const ModelDefinitionSchema = obj({
  id: str({ minLength: 1 }),
  api: opt(str({ minLength: 1 })),
  baseUrl: opt(str({ minLength: 1 })),
  ...overrideFields,
});

/** Changes to the fields of a model that already exists. */
export const ModelOverrideSchema = obj(overrideFields);

/** One provider entry, as written. */
export const ProviderConfigSchema = obj({
  name: opt(str({ minLength: 1 })),
  baseUrl: opt(str({ minLength: 1 })),
  api: opt(str({ minLength: 1 })),
  apiKey: opt(str({ minLength: 1 })),
  headers: opt(Headers),
  authHeader: opt(bool()),
  models: opt(arr(ModelDefinitionSchema)),
  modelOverrides: opt(map(ModelOverrideSchema)),
});

/** The whole file: the providers it adds or changes. */
export const ModelsConfigSchema = obj({
  $schema: opt(str()),
  providers: opt(map(ProviderConfigSchema)),
});

export type ModelsConfig = Static<typeof ModelsConfigSchema>;
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelDefinition = Static<typeof ModelDefinitionSchema>;
export type ModelOverride = Static<typeof ModelOverrideSchema>;
