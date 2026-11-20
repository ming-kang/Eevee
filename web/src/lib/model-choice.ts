import type { ModelSpecView } from "@shared/protocol/contract.ts";
import {
  type ModelChoice,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../../src/domain/index.ts";

/** A level as the menus write it: `High`, `X-High`. */
export const levelLabel = (level: ThinkingLevel): string =>
  level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);

type ModelRef = { provider: string; modelId: string };

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
  a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;

/** The levels a model takes, from the catalog; one the catalog does not list takes only `off`. */
export function levelsOf(
  available: readonly ModelSpecView[],
  choice: ModelRef | undefined,
): readonly ThinkingLevel[] {
  return available.find((spec) => sameModel(spec, choice))?.thinkingLevels ?? ["off"];
}

/** The nearest level a model takes: the same one, else the next one up, else the next one down. */
export function clampLevel(levels: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (levels.includes(level)) return level;
  const at = THINKING_LEVELS.indexOf(level);
  const up = THINKING_LEVELS.slice(at + 1).find((candidate) => levels.includes(candidate));
  const down = THINKING_LEVELS.slice(0, at).findLast((candidate) => levels.includes(candidate));
  return up ?? down ?? "off";
}

/** The choice after picking `spec`: its thinking level carried over as far as the new model allows. */
export function switchModel(current: ModelChoice | undefined, spec: ModelSpecView): ModelChoice {
  const level = clampLevel(spec.thinkingLevels, current?.thinkingLevel ?? "off");
  return {
    provider: spec.provider,
    modelId: spec.modelId,
    ...(level === "off" ? {} : { thinkingLevel: level }),
  };
}

export function groupModels(
  available: readonly ModelSpecView[],
  query: string,
): [string, ModelSpecView[]][] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, ModelSpecView[]>();
  for (const spec of available) {
    if (q && !`${spec.provider}/${spec.modelId} ${spec.name}`.toLowerCase().includes(q)) continue;
    groups.set(spec.provider, [...(groups.get(spec.provider) ?? []), spec]);
  }
  return [...groups.entries()];
}
