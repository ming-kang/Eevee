import type { EngineSettings, ProjectUsageResponse } from "@eevee/protocol";

export function tabular(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join("\t")).join("\n");
}

export function formatSettings(settings: EngineSettings): string {
  return JSON.stringify(settings, null, 2);
}

export function formatProjectUsage(response: ProjectUsageResponse): string {
  const lines: string[] = [`Usage for project ${response.projectId}:`];
  const models = Object.entries(response.usage.models);
  const tools = Object.entries(response.usage.tools);
  if (models.length === 0 && tools.length === 0) {
    lines.push("No recorded usage yet.");
    return lines.join("\n");
  }
  if (models.length > 0) {
    lines.push("Models:");
    for (const [key, metric] of models) {
      lines.push(
        `- ${key}: totalTokens=${metric.totalTokens} (in=${metric.input}, out=${metric.output}, cacheRead=${metric.cacheRead}, cacheWrite=${metric.cacheWrite}) cost=$${metric.cost.total.toFixed(6)}`,
      );
    }
  }
  if (tools.length > 0) {
    lines.push("Tools:");
    for (const [key, metric] of tools) {
      lines.push(
        `- ${key}: totalTokens=${metric.totalTokens} cost=$${metric.cost.total.toFixed(6)}`,
      );
    }
  }
  return lines.join("\n");
}
