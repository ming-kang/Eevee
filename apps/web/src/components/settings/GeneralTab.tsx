import { AddIcon, RemoveIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  IconButton,
  PageHeader,
  Section,
  SegmentedControl,
  Separator,
} from "@earendil-works/elanor-react";
import { type Locale, useI18n } from "../../lib/i18n.ts";
import { type ThemePreference, useTheme } from "../../lib/theme.ts";
import { CODE_SIZE_BOUNDS, UI_SIZE_BOUNDS, useTypography } from "../../lib/typography.ts";

function FontSizeStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ev-pref-row">
      <div className="ev-pref-label">{label}</div>
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
    <div className="ev-settings-stack ev-settings-narrow">
      <Section.Root className="ev-settings-section">
        <PageHeader.Root className="ev-section-header">
          <PageHeader.Row>
            <PageHeader.Title level={2} className="ev-section-title">
              {t("general.appearanceTitle")}
            </PageHeader.Title>
          </PageHeader.Row>
        </PageHeader.Root>
        <Section.Content>
          <div className="ev-settings-card">
            <div className="ev-pref-row">
              <div className="ev-pref-label">{t("general.language")}</div>
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
              <div className="ev-pref-label">{t("general.theme")}</div>
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
                <SegmentedControl.Item value="dark">
                  {t("sidebar.theme.dark")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            </div>
          </div>
        </Section.Content>
      </Section.Root>

      <Section.Root className="ev-settings-section">
        <PageHeader.Root className="ev-section-header">
          <PageHeader.Row>
            <PageHeader.Title level={2} className="ev-section-title">
              {t("general.typographyTitle")}
            </PageHeader.Title>
            {!isDefaultSizes && (
              <PageHeader.Actions>
                <Button hierarchy="tertiary" density="compact" onClick={typography.reset}>
                  {t("general.resetSizes")}
                </Button>
              </PageHeader.Actions>
            )}
          </PageHeader.Row>
        </PageHeader.Root>
        <Section.Content>
          <div className="ev-settings-card">
            <FontSizeStepper
              label={t("general.uiSize")}
              value={typography.uiSize}
              min={UI_SIZE_BOUNDS.min}
              max={UI_SIZE_BOUNDS.max}
              onChange={typography.setUiSize}
            />
            <Separator />
            <FontSizeStepper
              label={t("general.codeSize")}
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
        </Section.Content>
      </Section.Root>
    </div>
  );
}
