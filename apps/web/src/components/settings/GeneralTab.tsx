import { AddIcon, CheckIcon, RemoveIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  IconButton,
  PageHeader,
  Section,
  SegmentedControl,
  Separator,
} from "@earendil-works/elanor-react";
import { type Locale, useI18n } from "../../lib/i18n.ts";
import {
  THEME_PRESETS,
  type ThemePreference,
  type ThemePresetMeta,
  useTheme,
} from "../../lib/theme.ts";
import {
  type ChatWidth,
  CODE_SIZE_BOUNDS,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_PROSE_FONT,
  type ProseFont,
  UI_SIZE_BOUNDS,
  useTypography,
} from "../../lib/typography.ts";
import { EvTooltip } from "../EvTooltip.tsx";

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

function ModePreviewCard({
  mode,
  label,
  selected,
  onSelect,
}: {
  readonly mode: ThemePreference;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <EvTooltip content={label} side="top">
      <button
        type="button"
        className={`ev-mode-card ev-mode-card-${mode}`}
        aria-label={label}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="ev-mode-mini-bars" aria-hidden="true">
          <span className="ev-mode-mini-bar short" />
          <span className="ev-mode-mini-bar" />
        </span>
        {selected && (
          <span className="ev-card-check" aria-hidden="true">
            <CheckIcon width={12} height={12} />
          </span>
        )}
      </button>
    </EvTooltip>
  );
}

function PresetCard({
  preset,
  scheme,
  selected,
  onSelect,
}: {
  readonly preset: ThemePresetMeta;
  readonly scheme: "light" | "dark";
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  const swatches = preset.swatches[scheme];
  const [canvasBg, , , fgColor] = swatches;

  return (
    <button
      type="button"
      className="ev-preset-card"
      aria-pressed={selected}
      style={{ background: canvasBg, color: fgColor }}
      onClick={onSelect}
    >
      <div className="ev-preset-card-head">
        <span className="ev-preset-card-name">{t(`general.preset.${preset.id}` as const)}</span>
        <span className="ev-preset-card-tone">{t(`general.tone.${preset.tone}` as const)}</span>
      </div>
      <div className="ev-preset-swatches" aria-hidden="true">
        {(["bg", "side", "surface", "fg", "accent"] as const).map((slot, idx) => (
          <span
            key={`${preset.id}:${slot}`}
            className="ev-preset-swatch"
            style={{ background: swatches[idx] }}
          />
        ))}
      </div>
      {selected && (
        <span className="ev-card-check" aria-hidden="true">
          <CheckIcon width={12} height={12} />
        </span>
      )}
    </button>
  );
}

export function GeneralTab() {
  const { locale, setLocale, t } = useI18n();
  const theme = useTheme();
  const typography = useTypography();

  const isDefaultTypography =
    typography.uiSize === UI_SIZE_BOUNDS.default &&
    typography.codeSize === CODE_SIZE_BOUNDS.default &&
    typography.chatWidth === DEFAULT_CHAT_WIDTH &&
    typography.proseFont === DEFAULT_PROSE_FONT;

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

            <div className="ev-pref-block">
              <div className="ev-pref-label">{t("general.theme")}</div>
              <fieldset className="ev-mode-card-grid" aria-label={t("general.theme")}>
                {(["light", "system", "dark"] as const).map((mode) => (
                  <ModePreviewCard
                    key={mode}
                    mode={mode}
                    label={t(`sidebar.theme.${mode}` as const)}
                    selected={theme.preference === mode}
                    onSelect={() => theme.setPreference(mode)}
                  />
                ))}
              </fieldset>
            </div>

            <Separator />

            <div className="ev-pref-block">
              <div className="ev-pref-label">{t("general.preset")}</div>
              <fieldset className="ev-preset-card-grid" aria-label={t("general.preset")}>
                {THEME_PRESETS.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    scheme={theme.scheme}
                    selected={theme.preset === preset.id}
                    onSelect={() => theme.setPreset(preset.id)}
                  />
                ))}
              </fieldset>
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
            {!isDefaultTypography && (
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
            <div className="ev-pref-row">
              <div className="ev-pref-label">{t("general.chatWidth")}</div>
              <SegmentedControl.Root
                density="compact"
                value={[typography.chatWidth]}
                onValueChange={(vals) => {
                  const next = vals[0];
                  if (next === "standard" || next === "wide") {
                    typography.setChatWidth(next as ChatWidth);
                  }
                }}
              >
                <SegmentedControl.Item value="standard">
                  {t("general.chatWidth.standard")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="wide">
                  {t("general.chatWidth.wide")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            </div>
            <Separator />
            <div className="ev-pref-row">
              <div className="ev-pref-label">{t("general.proseFont")}</div>
              <SegmentedControl.Root
                density="compact"
                value={[typography.proseFont]}
                onValueChange={(vals) => {
                  const next = vals[0];
                  if (next === "wenkai" || next === "sans" || next === "mono") {
                    typography.setProseFont(next as ProseFont);
                  }
                }}
              >
                <SegmentedControl.Item value="wenkai">
                  {t("general.proseFont.wenkai")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="sans">
                  {t("general.proseFont.sans")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="mono">
                  {t("general.proseFont.mono")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            </div>
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
