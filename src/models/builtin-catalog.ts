/**
 * pi-ai's own model catalog as a reference for models.json entries. A gateway's model is often a built-in one
 * under another provider, so its name, limits and prices can be copied instead of typed. The catalog is the one
 * pi-ai ships, read without credentials or models.json. Matching goes by the exact id, then the same id up to
 * case, separators and a vendor prefix, then a fuzzy match on id, name and provider; within each group the
 * models on the caller's API come first.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** One built-in model, with the fields a models.json entry can take from it. */
export type BuiltinModelRef = {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The reference also prices by input size; those tiers are never copied. */
  costTiers: boolean;
};

export const MAX_MATCHES = 8;

/** Every chat model pi-ai ships, as generated. */
export function builtinCatalog(): BuiltinModelRef[] {
  return getBuiltinProviders().flatMap((provider) =>
    getBuiltinModels(provider).map((model) => refOf(provider, model)),
  );
}

/** A catalog model as a reference: what a models.json entry can copy, and whether its prices have tiers. */
export function refOf(provider: string, model: Model<Api>): BuiltinModelRef {
  const { input, output, cacheRead, cacheWrite, tiers } = model.cost;
  return {
    provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input, output, cacheRead, cacheWrite },
    costTiers: (tiers?.length ?? 0) > 0,
  };
}

/** Case-insensitive and separator-tolerant, without a vendor prefix; keeps version and date suffixes. */
export function normalizeId(id: string): string {
  return id
    .slice(id.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The built-in models closest to `query`, best first, at most `max`. */
export function matchBuiltinModels(
  catalog: readonly BuiltinModelRef[],
  query: string,
  preferredApi?: string,
  max = MAX_MATCHES,
): BuiltinModelRef[] {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const normalized = normalizeId(trimmed);
  const exact: BuiltinModelRef[] = [];
  const close: BuiltinModelRef[] = [];
  const fuzzy: { ref: BuiltinModelRef; score: number }[] = [];
  for (const ref of catalog) {
    if (ref.id === trimmed) exact.push(ref);
    else if (normalizeId(ref.id) === normalized) close.push(ref);
    else {
      const score = fuzzyScore(`${ref.id} ${ref.name} ${ref.provider}`.toLowerCase(), trimmed);
      if (score !== undefined) fuzzy.push({ ref, score });
    }
  }
  const byApi = (a: BuiltinModelRef, b: BuiltinModelRef) =>
    Number(a.api !== preferredApi) - Number(b.api !== preferredApi) ||
    a.id.localeCompare(b.id) ||
    a.provider.localeCompare(b.provider);
  fuzzy.sort((a, b) => a.score - b.score || byApi(a.ref, b.ref));
  return [...exact.sort(byApi), ...close.sort(byApi), ...fuzzy.map((f) => f.ref)].slice(0, max);
}

/** Lower is closer; `undefined` when some word of the query does not appear in order in `text`. */
function fuzzyScore(text: string, query: string): number | undefined {
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const score = wordScore(text, word);
    if (score === undefined) return undefined;
    total += score;
  }
  return total;
}

/**
 * A run of the word scores best, at a word start better still. Otherwise its letters in order, scored by the
 * gaps between them; letters scattered wider than the word is long are a coincidence, not a match.
 */
function wordScore(text: string, word: string): number | undefined {
  const at = text.indexOf(word);
  if (at >= 0) return at === 0 || !/[a-z0-9]/.test(text[at - 1] ?? "") ? 0 : 1;
  let gaps = 0;
  let last = -1;
  for (const char of word) {
    const found = text.indexOf(char, last + 1);
    if (found < 0) return undefined;
    if (last >= 0) gaps += found - last - 1;
    last = found;
  }
  return gaps > word.length ? undefined : 2 + gaps;
}
