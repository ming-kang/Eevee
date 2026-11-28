import {
  ROUTER_TOGGLEABLE_TOOLS,
  type ToolsSettings,
  WORKER_DEFAULT_DISABLED_TOOLS,
  WORKER_TOGGLEABLE_TOOLS,
} from "@eevee/protocol";
import { t } from "../../lib/i18n.ts";

export type ToolsEditorVariant = "global" | "project";
export type ToolRole = "router" | "worker";

export function defaultToolEnabled(role: ToolRole, name: string): boolean {
  return role === "router" || !WORKER_DEFAULT_DISABLED_TOOLS.some((tool) => tool === name);
}

export function isToggleableTool(role: ToolRole, name: string): boolean {
  const tools: readonly string[] =
    role === "router" ? ROUTER_TOGGLEABLE_TOOLS : WORKER_TOGGLEABLE_TOOLS;
  return tools.includes(name);
}

function cleanToolMap(
  role: ToolRole,
  overrides: Readonly<Record<string, boolean>> | undefined,
  global: boolean,
): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  const next: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(overrides)) {
    if (global && isToggleableTool(role, name) && enabled === defaultToolEnabled(role, name)) {
      continue;
    }
    next[name] = enabled;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function cleanToolsSettings(
  value: ToolsSettings | undefined,
  global: boolean,
): ToolsSettings | undefined {
  if (!value) return undefined;
  const router = cleanToolMap("router", value.router, global);
  const worker = cleanToolMap("worker", value.worker, global);
  const rawCodemode = value.codemode ? { ...value.codemode } : undefined;
  if (global && rawCodemode?.mode === "on") delete rawCodemode.mode;
  const codemode = rawCodemode && Object.keys(rawCodemode).length > 0 ? rawCodemode : undefined;
  if (!router && !worker && !codemode) return undefined;
  return {
    ...(router ? { router } : {}),
    ...(worker ? { worker } : {}),
    ...(codemode ? { codemode } : {}),
  };
}

export function hasToolsOverrides(value: ToolsSettings | undefined): boolean {
  if (!value) return false;
  return [value.router, value.worker, value.codemode].some(
    (section) => section !== undefined && Object.keys(section).length > 0,
  );
}

export function validateInlineBudgetInput(rawInlineBudget: string): string | undefined {
  const trimmed = rawInlineBudget.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return t("tools.invalidInlineBudget");
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return t("tools.invalidInlineBudget");
  return undefined;
}

export function resolveToolsSettings(
  value: ToolsSettings | undefined,
  rawInlineBudget: string,
  variant: ToolsEditorVariant,
): ToolsSettings | undefined {
  const error = validateInlineBudgetInput(rawInlineBudget);
  if (error) throw new Error(error);
  const trimmed = rawInlineBudget.trim();
  const inlineBudget = trimmed ? Number(trimmed) : undefined;
  const codemode = { ...value?.codemode };
  if (inlineBudget === undefined) delete codemode.inlineBudget;
  else codemode.inlineBudget = inlineBudget;
  return cleanToolsSettings({ ...value, codemode }, variant === "global");
}
