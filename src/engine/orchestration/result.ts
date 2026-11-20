import type { JsonValue } from "@earendil-works/chord/json";

export type OrchestrationResult = {
  text: string;
  details?: JsonValue;
  control?: { terminate?: boolean; handoff?: string };
  error?: boolean;
};

export function ok(
  text: string,
  details?: JsonValue,
  control?: OrchestrationResult["control"],
): OrchestrationResult {
  return {
    text,
    ...(details === undefined ? {} : { details }),
    ...(control === undefined ? {} : { control }),
  };
}

export function fail(text: string): OrchestrationResult {
  return { text, error: true };
}
