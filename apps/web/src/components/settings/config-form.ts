import type { EngineSettings, ModelChoice, ToolsSettings } from "@eevee/protocol";
import { t } from "../../lib/i18n.ts";
import { deepEqualJson } from "../../lib/object.ts";
import {
  cleanToolsSettings,
  resolveToolsSettings,
  validateInlineBudgetInput,
} from "./tools-settings.ts";

export type ConfigFormState = {
  readonly maxActiveWorkers: string;
  readonly backgroundAfterSec: string;
  readonly routerContextTokens: string;
  readonly idleHibernateMin: string;
  readonly routerModel: ModelChoice | undefined;
  readonly workerModel: ModelChoice | undefined;
  readonly dreamerModel: ModelChoice | undefined;
  readonly tools: ToolsSettings | undefined;
  readonly inlineBudget: string;
};

export type ConfigFormErrors = {
  readonly maxActiveWorkers?: string;
  readonly backgroundAfterSec?: string;
  readonly routerContextTokens?: string;
  readonly idleHibernateMin?: string;
  readonly inlineBudget?: string;
};

export const INITIAL_CONFIG_FORM_STATE: ConfigFormState = {
  maxActiveWorkers: "3",
  backgroundAfterSec: "30",
  routerContextTokens: "80000",
  idleHibernateMin: "10",
  routerModel: undefined,
  workerModel: undefined,
  dreamerModel: undefined,
  tools: undefined,
  inlineBudget: "",
};

function formatScaledValue(value: number, maxDecimals: number): string {
  if (value === 0) return "0";
  return Number(value.toFixed(maxDecimals)).toString();
}

export function msToSecondsText(ms: number): string {
  return formatScaledValue(ms / 1_000, 3);
}

export function msToMinutesText(ms: number): string {
  const exact = ms / 60_000;
  if (ms % 600 === 0) return formatScaledValue(exact, 2);
  return formatScaledValue(exact, 6);
}

function parseNonNegativeInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveInt(raw: string): number | undefined {
  const parsed = parseNonNegativeInt(raw);
  return parsed !== undefined && parsed >= 1 ? parsed : undefined;
}

function parseNonNegativeDecimal(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function secondsTextToMs(raw: string): number | undefined {
  const seconds = parseNonNegativeDecimal(raw);
  if (seconds === undefined) return undefined;
  const ms = Math.round(seconds * 1_000);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

export function minutesTextToMs(raw: string): number | undefined {
  const minutes = parseNonNegativeDecimal(raw);
  if (minutes === undefined) return undefined;
  const ms = Math.round(minutes * 60_000);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

export function formatTokenShorthand(raw: string): string | undefined {
  const tokens = parsePositiveInt(raw);
  if (tokens === undefined || tokens < 1_000) return undefined;
  if (tokens >= 1_000_000) return `${formatScaledValue(tokens / 1_000_000, 2)}M`;
  return `${formatScaledValue(tokens / 1_000, 1)}k`;
}

export function configFormFromSettings(settings: EngineSettings): ConfigFormState {
  const normalizedTools = cleanToolsSettings(settings.tools, true);
  return {
    maxActiveWorkers: String(settings.maxActiveWorkers ?? 3),
    backgroundAfterSec: msToSecondsText(settings.backgroundAfterMs ?? 30_000),
    routerContextTokens: String(settings.routerContextTokens ?? 80_000),
    idleHibernateMin: msToMinutesText(settings.idleHibernateMs ?? 600_000),
    routerModel: settings.models?.router,
    workerModel: settings.models?.worker,
    dreamerModel: settings.models?.dreamer,
    tools: normalizedTools,
    inlineBudget: String(normalizedTools?.codemode?.inlineBudget ?? ""),
  };
}

export function validateConfigForm(form: ConfigFormState): ConfigFormErrors {
  const errors: {
    maxActiveWorkers?: string;
    backgroundAfterSec?: string;
    routerContextTokens?: string;
    idleHibernateMin?: string;
    inlineBudget?: string;
  } = {};

  if (parseNonNegativeInt(form.maxActiveWorkers) === undefined) {
    errors.maxActiveWorkers = t("config.error.nonNegativeInt");
  }
  if (secondsTextToMs(form.backgroundAfterSec) === undefined) {
    errors.backgroundAfterSec = t("config.error.nonNegativeNumber");
  }
  if (parsePositiveInt(form.routerContextTokens) === undefined) {
    errors.routerContextTokens = t("config.error.positiveInt");
  }
  if (minutesTextToMs(form.idleHibernateMin) === undefined) {
    errors.idleHibernateMin = t("config.error.nonNegativeNumber");
  }
  const inlineBudgetError = validateInlineBudgetInput(form.inlineBudget);
  if (inlineBudgetError) {
    errors.inlineBudget = inlineBudgetError;
  }
  return errors;
}

export function hasConfigFormErrors(errors: ConfigFormErrors): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}

export function isConfigFormDirty(current: ConfigFormState, saved: ConfigFormState): boolean {
  return !deepEqualJson(current, saved);
}

export function buildEngineSettingsFromForm(form: ConfigFormState): EngineSettings {
  const maxActiveWorkers = parseNonNegativeInt(form.maxActiveWorkers);
  if (maxActiveWorkers === undefined) {
    throw new Error(`${t("config.maxActiveWorkers")}: ${t("config.error.nonNegativeInt")}`);
  }
  const backgroundAfterMs = secondsTextToMs(form.backgroundAfterSec);
  if (backgroundAfterMs === undefined) {
    throw new Error(`${t("config.backgroundAfter")}: ${t("config.error.nonNegativeNumber")}`);
  }
  const routerContextTokens = parsePositiveInt(form.routerContextTokens);
  if (routerContextTokens === undefined) {
    throw new Error(`${t("config.routerContextTokens")}: ${t("config.error.positiveInt")}`);
  }
  const idleHibernateMs = minutesTextToMs(form.idleHibernateMin);
  if (idleHibernateMs === undefined) {
    throw new Error(`${t("config.idleHibernate")}: ${t("config.error.nonNegativeNumber")}`);
  }

  const models =
    form.routerModel || form.workerModel || form.dreamerModel
      ? {
          ...(form.routerModel ? { router: form.routerModel } : {}),
          ...(form.workerModel ? { worker: form.workerModel } : {}),
          ...(form.dreamerModel ? { dreamer: form.dreamerModel } : {}),
        }
      : undefined;

  const nextTools = resolveToolsSettings(form.tools, form.inlineBudget, "global");
  return {
    maxActiveWorkers,
    backgroundAfterMs,
    routerContextTokens,
    idleHibernateMs,
    ...(models ? { models } : {}),
    ...(nextTools ? { tools: nextTools } : {}),
  };
}
