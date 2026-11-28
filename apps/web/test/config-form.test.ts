import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineSettings } from "@eevee/protocol";
import {
  buildEngineSettingsFromForm,
  configFormFromSettings,
  formatTokenShorthand,
  hasConfigFormErrors,
  isConfigFormDirty,
  minutesTextToMs,
  msToMinutesText,
  msToSecondsText,
  secondsTextToMs,
  validateConfigForm,
} from "../src/components/settings/config-form.ts";
import { cleanToolsSettings } from "../src/components/settings/tools-settings.ts";

test("duration helpers convert ms to human seconds and minutes without precision loss", () => {
  assert.equal(msToSecondsText(30_000), "30");
  assert.equal(msToSecondsText(1_500), "1.5");
  assert.equal(msToSecondsText(0), "0");
  assert.equal(secondsTextToMs("30"), 30_000);
  assert.equal(secondsTextToMs("1.5"), 1_500);
  assert.equal(secondsTextToMs("0"), 0);
  assert.equal(secondsTextToMs("-1"), undefined);
  assert.equal(secondsTextToMs("abc"), undefined);

  assert.equal(msToMinutesText(600_000), "10");
  assert.equal(msToMinutesText(45_000), "0.75");
  assert.equal(msToMinutesText(0), "0");
  assert.equal(minutesTextToMs("10"), 600_000);
  assert.equal(minutesTextToMs("0.75"), 45_000);
  assert.equal(minutesTextToMs(msToMinutesText(5_000)), 5_000);
  assert.equal(minutesTextToMs(""), undefined);
});

test("configFormFromSettings and buildEngineSettingsFromForm roundtrip cleanly and detect dirty state", () => {
  const settings: EngineSettings = {
    maxActiveWorkers: 4,
    backgroundAfterMs: 15_000,
    routerContextTokens: 120_000,
    idleHibernateMs: 900_000,
    models: {
      router: { provider: "anthropic", modelId: "claude-sonnet-4" },
    },
    tools: {
      worker: { powershell: true },
      codemode: { mode: "only", inlineBudget: 4000 },
    },
  };

  const form = configFormFromSettings(settings);
  assert.equal(form.backgroundAfterSec, "15");
  assert.equal(form.idleHibernateMin, "15");
  assert.equal(form.inlineBudget, "4000");
  assert.equal(isConfigFormDirty(form, form), false);
  assert.deepEqual(buildEngineSettingsFromForm(form), settings);

  const edited = { ...form, backgroundAfterSec: "20" };
  assert.equal(isConfigFormDirty(edited, form), true);
  assert.equal(buildEngineSettingsFromForm(edited).backgroundAfterMs, 20_000);

  const normalizedDefaultTools = cleanToolsSettings(
    { codemode: { mode: "on" }, router: { read: true }, worker: { ls: false } },
    true,
  );
  assert.equal(normalizedDefaultTools, undefined);
});

test("validateConfigForm reports field errors and formatTokenShorthand summarizes large budgets", () => {
  const base = configFormFromSettings({});
  assert.equal(hasConfigFormErrors(validateConfigForm(base)), false);

  const invalid = {
    ...base,
    maxActiveWorkers: "-1",
    backgroundAfterSec: "fast",
    routerContextTokens: "0",
    idleHibernateMin: "",
    inlineBudget: "12.5",
  };
  const errors = validateConfigForm(invalid);
  assert.equal(hasConfigFormErrors(errors), true);
  assert.ok(errors.maxActiveWorkers);
  assert.ok(errors.backgroundAfterSec);
  assert.ok(errors.routerContextTokens);
  assert.ok(errors.idleHibernateMin);
  assert.ok(errors.inlineBudget);
  assert.throws(() => buildEngineSettingsFromForm(invalid));

  assert.equal(formatTokenShorthand("80000"), "80k");
  assert.equal(formatTokenShorthand("12500"), "12.5k");
  assert.equal(formatTokenShorthand("1500000"), "1.5M");
  assert.equal(formatTokenShorthand("500"), undefined);
  assert.equal(formatTokenShorthand("invalid"), undefined);
});
