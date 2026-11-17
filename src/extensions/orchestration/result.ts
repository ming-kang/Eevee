import type { JsonValue } from "@earendil-works/chord/json";
import type { ToolControl, ToolExecutionResult } from "@earendil-works/pi-durable";

export function ok(text: string, details?: JsonValue, control?: ToolControl): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    ...(control === undefined ? {} : { control }),
  };
}

export function fail(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError: true };
}

export function missing<T extends object>(args: T, fields: readonly (keyof T)[]): string[] {
  return fields.filter((f) => args[f] === undefined || args[f] === "").map(String);
}
