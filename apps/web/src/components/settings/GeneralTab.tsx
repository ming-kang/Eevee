import { AddIcon, RemoveIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Heading,
  IconButton,
  SegmentedControl,
  Separator,
} from "@earendil-works/elanor-react";
import { type Locale, useI18n } from "../../lib/i18n.ts";
import { type ThemePreference, useTheme } from "../../lib/theme.ts";
import { CODE_SIZE_BOUNDS, UI_SIZE_BOUNDS, useTypography } from "../../lib/typography.ts";

function FontSizeStepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ev-pref-row">
      <div className="ev-pref-copy">
        <div className="ev-pref-label">{label}</div>
        <div className="ev-pref-hint">{hint}</div>
      </div>
      <div className="ev-stepper">
        <IconButton
          aria-label={t("general.decrease")}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <RemoveIcon width={15} height={15} />
        </IconButton>
        <span className="ev-stepper-val ev-num">{value}px</span>
        <IconButton
          aria-label={t("general.increase")}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <AddIcon width={15} height={15} />
        </IconButton>
      </div>
    </div>
  );
}

export function GeneralTab() {
  const { locale, setLocale, t } = useI18n();
  const theme = useTheme();
  const typography = useTypography();

  const isDefaultSizes =
    typography.uiSize === UI_SIZE_BOUNDS.default &&
    typography.codeSize === CODE_SIZE_BOUNDS.default;

  return (
    <div className="ev-settings-section" style={{ gap: 22 }}>
      <div className="ev-settings-section">
        <Heading level={2} size={5}>
          {t("general.appearanceTitle")}
        </Heading>
        <div className="ev-settings-card">
          <div className="ev-pref-row">
            <div className="ev-pref-copy">
              <div className="ev-pref-label">{t("general.language")}</div>
              <div className="ev-pref-hint">{t("general.languageHint")}</div>
            </div>
            <SegmentedControl.Root
              density="compact"
              value={[locale]}
              onValueChange={(vals) => {
                const next = vals[0];
                if (next === "zh-CN" || next === "en") setLocale(next as Locale);
              }}
            >
              <SegmentedControl.Item value="zh-CN">简体中文</SegmentedControl.Item>
              <SegmentedControl.Item value="en">English</SegmentedControl.Item>
            </SegmentedControl.Root>
          </div>

          <Separator />

          <div className="ev-pref-row">
            <div className="ev-pref-copy">
              <div className="ev-pref-label">{t("general.theme")}</div>
              <div className="ev-pref-hint">{t("general.themeHint")}</div>
            </div>
            <SegmentedControl.Root
              density="compact"
              value={[theme.preference]}
              onValueChange={(vals) => {
                const next = vals[0];
                if (next === "system" || next === "light" || next === "dark") {
                  theme.setPreference(next as ThemePreference);
                }
              }}
            >
              <SegmentedControl.Item value="system">
                {t("sidebar.theme.system")}
              </SegmentedControl.Item>
              <SegmentedControl.Item value="light">
                {t("sidebar.theme.light")}
              </SegmentedControl.Item>
              <SegmentedControl.Item value="dark">{t("sidebar.theme.dark")}</SegmentedControl.Item>
            </SegmentedControl.Root>
          </div>
        </div>
      </div>

      <div className="ev-settings-section">
        <div className="ev-settings-head">
          <Heading level={2} size={5}>
            {t("general.typographyTitle")}
          </Heading>
          {!isDefaultSizes && (
            <Button hierarchy="tertiary" density="compact" onClick={typography.reset}>
              {t("general.resetSizes")}
            </Button>
          )}
        </div>
        <div className="ev-settings-card">
          <FontSizeStepper
            label={t("general.uiSize")}
            hint={t("general.uiSizeHint", { min: UI_SIZE_BOUNDS.min, max: UI_SIZE_BOUNDS.max })}
            value={typography.uiSize}
            min={UI_SIZE_BOUNDS.min}
            max={UI_SIZE_BOUNDS.max}
            onChange={typography.setUiSize}
          />
          <Separator />
          <FontSizeStepper
            label={t("general.codeSize")}
            hint={t("general.codeSizeHint", {
              min: CODE_SIZE_BOUNDS.min,
              max: CODE_SIZE_BOUNDS.max,
            })}
            value={typography.codeSize}
            min={CODE_SIZE_BOUNDS.min}
            max={CODE_SIZE_BOUNDS.max}
            onChange={typography.setCodeSize}
          />
          <Separator />
          <div className="ev-typography-preview">
            <div className="ev-typography-preview-prose">{t("general.previewProse")}</div>
            <pre className="ev-pre">{t("general.previewCode")}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
