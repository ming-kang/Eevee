import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  format,
  modify,
  parseTree,
} from "jsonc-parser";
import { withFileLock, writeFileAtomic } from "../shared/file-lock.ts";
import { isEnoent, isRecord } from "../shared/guards.ts";
import {
  type ModelEntryConfig,
  type ModelOverrideConfig,
  type ModelsConfig,
  type ProviderConfig,
  parseModelsConfig,
} from "./model-config.ts";
import { composeProviders } from "./provider-composer.ts";

export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

export type MutableModelsConfig = Mutable<ModelsConfig>;
export type ProviderConfigPatch = {
  [K in keyof ProviderConfig]?: ProviderConfig[K] | null;
};
export type ModelOverridePatch = {
  [K in keyof ModelOverrideConfig]?: ModelOverrideConfig[K] | null;
};

export type ModelsJsonDocument = {
  readonly exists: boolean;
  readonly config: ModelsConfig;
  readonly rawText: string;
};

async function readOptionalRawText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function readModelsJsonDocument(filePath: string): Promise<ModelsJsonDocument> {
  const rawText = await readOptionalRawText(filePath);
  if (rawText === undefined) {
    return { exists: false, config: { providers: {} }, rawText: "" };
  }
  return { exists: true, config: parseModelsConfig(rawText), rawText };
}

function pruneDraft(draft: MutableModelsConfig): void {
  for (const [providerId, provider] of Object.entries(draft.providers)) {
    if (provider.modelOverrides && Object.keys(provider.modelOverrides).length === 0) {
      delete provider.modelOverrides;
    }
    if (provider.models && provider.models.length === 0) delete provider.models;
    if (Object.keys(provider).length === 0) delete draft.providers[providerId];
  }
}

// jsonc-parser exposes these token kinds only as an ambient const enum.
const JSON_SCAN_STRING = 10;
const JSON_SCAN_EOF = 17;

function formattingOptions(text: string): {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly eol: string;
} {
  const scanner = createScanner(text, false);
  let insertSpaces = true;
  let tabSize = 2;
  let token = scanner.scan();
  while (token !== JSON_SCAN_EOF) {
    if (token === JSON_SCAN_STRING && scanner.getTokenStartLine() > 0) {
      const column = scanner.getTokenStartCharacter();
      if (column > 0) {
        const lineStart = text.lastIndexOf("\n", scanner.getTokenOffset()) + 1;
        const indentation = text.slice(lineStart, scanner.getTokenOffset());
        if (indentation.includes("\t")) {
          insertSpaces = false;
          tabSize = 1;
        } else if (/^ +$/.test(indentation)) {
          tabSize = indentation.length;
        }
        break;
      }
    }
    token = scanner.scan();
  }
  return { insertSpaces, tabSize, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function applyValueEdit(
  text: string,
  path: readonly (string | number)[],
  value: unknown,
  options: ReturnType<typeof formattingOptions>,
  isArrayInsertion = false,
): string {
  return applyEdits(
    text,
    modify(text, [...path], value, {
      formattingOptions: options,
      ...(isArrayInsertion ? { isArrayInsertion: true } : {}),
    }),
  );
}

function applyMinimalEdits(
  originalText: string,
  before: unknown,
  after: unknown,
  options: ReturnType<typeof formattingOptions>,
): string {
  let text = originalText;

  function visit(path: readonly (string | number)[], left: unknown, right: unknown): void {
    if (isDeepStrictEqual(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length === right.length) {
        for (let index = 0; index < left.length; index++) {
          visit([...path, index], left[index], right[index]);
        }
        return;
      }
      if (
        right.length > left.length &&
        left.every((entry, index) => isDeepStrictEqual(entry, right[index]))
      ) {
        for (let index = left.length; index < right.length; index++) {
          text = applyValueEdit(text, [...path, index], right[index], options, true);
        }
        return;
      }
      text = applyValueEdit(text, path, right, options);
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        visit([...path, key], left[key], right[key]);
      }
      return;
    }
    text = applyValueEdit(text, path, right, options);
  }

  visit([], before, after);
  return text;
}

async function backupExists(filePath: string): Promise<boolean> {
  return (await readOptionalRawText(`${filePath}.bak`)) !== undefined;
}

function validateModelsConfig(config: unknown): ModelsConfig {
  const candidate = parseModelsConfig(JSON.stringify(config));
  composeProviders(candidate);
  return candidate;
}

async function commitModelsJson(
  filePath: string,
  build: () => Promise<{
    readonly candidate: ModelsConfig;
    readonly nextText?: string;
    readonly existingRawText?: string;
  }>,
): Promise<ModelsConfig> {
  return withFileLock(filePath, async () => {
    const { candidate, nextText, existingRawText } = await build();
    if (nextText === undefined) return candidate;
    if (existingRawText !== undefined && !(await backupExists(filePath))) {
      await writeFileAtomic(`${filePath}.bak`, existingRawText, 0o600);
    }
    await writeFileAtomic(filePath, nextText, 0o600);
    return candidate;
  });
}

export async function mutateModelsJson(
  filePath: string,
  mutator: (draft: MutableModelsConfig) => void,
): Promise<ModelsConfig> {
  return commitModelsJson(filePath, async () => {
    const document = await readModelsJsonDocument(filePath);
    const draft = structuredClone(document.config) as MutableModelsConfig;
    mutator(draft);
    pruneDraft(draft);
    const candidate = validateModelsConfig(draft);

    if (isDeepStrictEqual(document.config, candidate)) return { candidate };

    let nextText: string;
    if (!document.exists || document.rawText.trim().length === 0) {
      const compact = JSON.stringify(candidate);
      const options = { insertSpaces: true, tabSize: 2, eol: "\n" };
      nextText = `${applyEdits(compact, format(compact, undefined, options))}\n`;
    } else {
      const bom = document.rawText.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
      const body = bom ? document.rawText.slice(1) : document.rawText;
      parseTree(body);
      nextText = bom + applyMinimalEdits(body, document.config, candidate, formattingOptions(body));
    }

    const tree = parseTree(nextText.charCodeAt(0) === 0xfeff ? nextText.slice(1) : nextText);
    if (!tree || !findNodeAtLocation(tree, ["providers"])) {
      throw new Error("Refusing to write models.json: generated document has no providers object");
    }
    parseModelsConfig(nextText);

    return {
      candidate,
      nextText,
      existingRawText: document.exists ? document.rawText : undefined,
    };
  });
}

export async function writeModelsJsonFile(
  filePath: string,
  config: ModelsConfig,
): Promise<ModelsConfig> {
  return commitModelsJson(filePath, async () => {
    const candidate = validateModelsConfig(config);
    const existingRawText = await readOptionalRawText(filePath);
    return {
      candidate,
      nextText: `${JSON.stringify(candidate, null, 2)}\n`,
      existingRawText,
    };
  });
}

function applyPatch<T extends object>(
  target: T,
  patch: Partial<{ [K in keyof T]: T[K] | null }>,
): void {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete record[key];
    } else if (value !== undefined) {
      record[key] = value;
    }
  }
}

export async function upsertProviderConfig(
  filePath: string,
  providerId: string,
  patch: ProviderConfigPatch,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    const provider = (draft.providers[providerId] ?? {}) as Mutable<ProviderConfig>;
    applyPatch(provider, patch);
    draft.providers[providerId] = provider;
  });
}

export async function deleteProviderConfig(
  filePath: string,
  providerId: string,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    delete draft.providers[providerId];
  });
}

export async function upsertCustomModel(
  filePath: string,
  providerId: string,
  model: ModelEntryConfig,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    const provider = (draft.providers[providerId] ?? {}) as Mutable<ProviderConfig>;
    const models = [...(provider.models ?? [])];
    const index = models.findIndex((entry) => entry.id === model.id);
    if (index < 0) {
      models.push(structuredClone(model) as Mutable<ModelEntryConfig>);
    } else {
      models[index] = { ...models[index], ...structuredClone(model) } as Mutable<ModelEntryConfig>;
    }
    provider.models = models;
    draft.providers[providerId] = provider;
  });
}

export async function deleteCustomModel(
  filePath: string,
  providerId: string,
  modelId: string,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    const provider = draft.providers[providerId];
    if (!provider?.models) return;
    provider.models = provider.models.filter((model) => model.id !== modelId);
  });
}

export async function upsertModelOverride(
  filePath: string,
  providerId: string,
  modelId: string,
  override: ModelOverridePatch,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    const provider = (draft.providers[providerId] ?? {}) as Mutable<ProviderConfig>;
    const overrides: Record<string, Mutable<ModelOverrideConfig>> = {
      ...(provider.modelOverrides ?? {}),
    };
    const current = (overrides[modelId] ?? {}) as Mutable<ModelOverrideConfig>;
    applyPatch(current, override);
    if (Object.keys(current).length === 0) {
      delete overrides[modelId];
    } else {
      overrides[modelId] = current;
    }
    provider.modelOverrides = overrides;
    draft.providers[providerId] = provider;
  });
}

export async function deleteModelOverride(
  filePath: string,
  providerId: string,
  modelId: string,
): Promise<ModelsConfig> {
  return mutateModelsJson(filePath, (draft) => {
    const provider = draft.providers[providerId];
    if (!provider?.modelOverrides) return;
    delete (provider.modelOverrides as Record<string, ModelOverrideConfig>)[modelId];
  });
}
