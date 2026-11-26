import type { Api, Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ALL_THINKING_LEVELS } from "./thinking-map.ts";

export type ResolvedModelSpec = {
  readonly kind: "resolved";
  readonly model: Model<Api>;
  readonly thinkingLevel?: ModelThinkingLevel;
};

export type ModelSpecResolution =
  | ResolvedModelSpec
  | { readonly kind: "ambiguous"; readonly matches: readonly Model<Api>[] }
  | { readonly kind: "not_found" };

type Candidate = {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ModelThinkingLevel;
};

function splitThinkingSuffix(spec: string): {
  readonly modelId: string;
  readonly thinkingLevel?: ModelThinkingLevel;
} {
  const colon = spec.lastIndexOf(":");
  if (colon < 0) return { modelId: spec };
  const suffix = spec.slice(colon + 1);
  if (!(ALL_THINKING_LEVELS as readonly string[]).includes(suffix)) return { modelId: spec };
  return { modelId: spec.slice(0, colon), thinkingLevel: suffix as ModelThinkingLevel };
}

function unique(models: readonly Model<Api>[]): readonly Model<Api>[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}\0${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finish(candidates: readonly Candidate[]): ModelSpecResolution {
  const models = unique(candidates.map((candidate) => candidate.model));
  if (models.length === 0) return { kind: "not_found" };
  if (models.length > 1) return { kind: "ambiguous", matches: models };
  const candidate = candidates[0];
  const model = models[0];
  if (!candidate || !model) return { kind: "not_found" };
  return {
    kind: "resolved",
    model,
    ...(candidate.thinkingLevel === undefined ? {} : { thinkingLevel: candidate.thinkingLevel }),
  };
}

function exactCandidates(
  models: readonly Model<Api>[],
  spec: string,
  caseInsensitive: boolean,
): readonly Candidate[] {
  const full = models.filter((model) =>
    caseInsensitive ? model.id.toLowerCase() === spec.toLowerCase() : model.id === spec,
  );
  if (full.length > 0) return full.map((model) => ({ model }));
  const suffix = splitThinkingSuffix(spec);
  if (suffix.thinkingLevel === undefined) return [];
  return models
    .filter((model) =>
      caseInsensitive
        ? model.id.toLowerCase() === suffix.modelId.toLowerCase()
        : model.id === suffix.modelId,
    )
    .map((model) => ({ model, thinkingLevel: suffix.thinkingLevel }));
}

function substringCandidates(models: readonly Model<Api>[], spec: string): readonly Candidate[] {
  function find(query: string, thinkingLevel?: ModelThinkingLevel): readonly Candidate[] {
    const lower = query.toLowerCase();
    return models
      .filter((model) => model.id.toLowerCase().includes(lower))
      .sort(
        (left, right) =>
          Number(right.id.toLowerCase().startsWith(lower)) -
            Number(left.id.toLowerCase().startsWith(lower)) ||
          left.id.length - right.id.length ||
          left.id.localeCompare(right.id),
      )
      .map((model) => ({ model, ...(thinkingLevel ? { thinkingLevel } : {}) }));
  }

  const full = find(spec);
  if (full.length > 0) return full;
  const suffix = splitThinkingSuffix(spec);
  return suffix.thinkingLevel ? find(suffix.modelId, suffix.thinkingLevel) : [];
}

export function resolveModelSpec(models: Models, spec: string): ModelSpecResolution {
  const trimmed = spec.trim();
  if (!trimmed) return { kind: "not_found" };
  const providers = [...models.getProviders()].sort(
    (left, right) => right.id.length - left.id.length,
  );

  for (const provider of providers) {
    const prefix = `${provider.id}/`;
    if (!trimmed.startsWith(prefix)) continue;
    const modelSpec = trimmed.slice(prefix.length);
    const available = models.getModels(provider.id);
    const exact = exactCandidates(available, modelSpec, false);
    if (exact.length > 0) return finish(exact);
    const insensitive = exactCandidates(available, modelSpec, true);
    if (insensitive.length > 0) return finish(insensitive);
    return finish(substringCandidates(available, modelSpec));
  }

  const available = models.getModels();
  const exact = exactCandidates(available, trimmed, false);
  if (exact.length > 0) return finish(exact);
  const insensitive = exactCandidates(available, trimmed, true);
  if (insensitive.length > 0) return finish(insensitive);
  return finish(substringCandidates(available, trimmed));
}
