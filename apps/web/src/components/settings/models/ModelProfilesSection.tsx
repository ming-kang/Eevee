import { AddIcon, DeleteIcon, ExperimentIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  IconButton,
  Input,
  PageHeader,
  Section,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type { ModelInfo, ModelProfile } from "@eevee/protocol";
import { useMemo } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import {
  findModelInfo,
  selectModelWithThinking,
  thinkingLevelsOfModel,
} from "../../../lib/model-choice.ts";
import { ModelChoiceMenu } from "../../ModelChoiceMenu.tsx";
import { SmokeTestResult } from "../SmokeTestResult.tsx";
import { useModelSmokeTests } from "../useModelSmokeTests.ts";

export type IndexedProfile = {
  readonly uid: number;
  readonly profile: ModelProfile;
};

let nextProfileUid = 1;

export function wrapProfiles(list: readonly ModelProfile[]): IndexedProfile[] {
  return list.map((profile) => ({ uid: nextProfileUid++, profile }));
}

export function createNextIndexedProfile(
  allModels: readonly ModelInfo[],
  index: number,
): IndexedProfile {
  const first = allModels.find((m) => m.available) ?? allModels[0];
  return {
    uid: nextProfileUid++,
    profile: {
      id: `profile-${index + 1}`,
      model: first
        ? selectModelWithThinking(first, undefined)
        : { provider: "openai", modelId: "gpt-4o" },
      description: "",
    },
  };
}

export type ModelProfilesSectionProps = {
  readonly allModels: readonly ModelInfo[];
  readonly profiles: readonly IndexedProfile[];
  readonly notes: string;
  readonly saving: boolean;
  readonly onAddProfile: () => void;
  readonly onUpdateProfile: (uid: number, next: ModelProfile) => void;
  readonly onRemoveProfile: (uid: number) => void;
  readonly onNotesChange: (value: string) => void;
  readonly onSave: () => void;
};

export function ModelProfilesSection({
  allModels,
  profiles,
  notes,
  saving,
  onAddProfile,
  onUpdateProfile,
  onRemoveProfile,
  onNotesChange,
  onSave,
}: ModelProfilesSectionProps) {
  const { t: translate } = useI18n();
  const { tests: profileTests, runTest: runSmokeTest, cancelTest } = useModelSmokeTests();

  const selectableModels = useMemo(() => {
    const available = allModels.filter((item) => item.available);
    return available.length > 0 ? available : allModels;
  }, [allModels]);

  const handleRemove = (uid: number) => {
    cancelTest(String(uid));
    onRemoveProfile(uid);
  };

  const runProfileTest = (uid: number, profile: ModelProfile) => {
    const provider = profile.model.provider.trim();
    const modelId = profile.model.modelId.trim();
    if (!provider || !modelId) return;
    void runSmokeTest(
      provider,
      modelId,
      profile.model.thinkingLevel ? { thinkingLevel: profile.model.thinkingLevel } : {},
      String(uid),
    );
  };

  return (
    <Section.Root className="ev-settings-section">
      <PageHeader.Root className="ev-section-header">
        <PageHeader.Row>
          <PageHeader.Title level={2} className="ev-section-title">
            {translate("models.profilesTitle")}
          </PageHeader.Title>
          <PageHeader.Actions>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<AddIcon width={15} height={15} />}
              onClick={onAddProfile}
            >
              {translate("common.add")}
            </Button>
            <Button hierarchy="primary" density="compact" pending={saving} onClick={onSave}>
              {translate("common.save")}
            </Button>
          </PageHeader.Actions>
        </PageHeader.Row>
      </PageHeader.Root>

      {profiles.map(({ uid, profile }) => {
        const providerValue = profile.model.provider.trim();
        const modelIdValue = profile.model.modelId.trim();
        const matchedModel = findModelInfo(allModels, profile.model);
        const supportedLevels = thinkingLevelsOfModel(matchedModel);
        const currentThinking = profile.model.thinkingLevel;
        const unsupportedCurrent =
          currentThinking !== undefined &&
          supportedLevels.length > 0 &&
          !supportedLevels.includes(currentThinking);
        const smoke = profileTests[String(uid)];

        return (
          <div key={uid} className="ev-settings-card">
            <div className="ev-profile-row">
              <Field.Root className="ev-profile-field-id">
                <Field.Label>{translate("models.profileId")}</Field.Label>
                <Input
                  type="text"
                  value={profile.id}
                  onValueChange={(value) => onUpdateProfile(uid, { ...profile, id: value })}
                />
              </Field.Root>
              <Field.Root className="ev-profile-field-model">
                <Field.Label>{translate("modelMenu.model")}</Field.Label>
                <ModelChoiceMenu
                  value={profile.model}
                  models={selectableModels}
                  placeholder={translate("modelMenu.choose")}
                  variant="field"
                  ariaLabel={translate("modelMenu.model")}
                  onChange={(nextModel) => {
                    if (nextModel) onUpdateProfile(uid, { ...profile, model: nextModel });
                  }}
                />
              </Field.Root>
              <div className="ev-profile-actions">
                <Button
                  type="button"
                  hierarchy="secondary"
                  density="compact"
                  iconStart={<ExperimentIcon width={14} height={14} />}
                  disabled={!providerValue || !modelIdValue}
                  pending={smoke?.loading === true}
                  onClick={() => runProfileTest(uid, profile)}
                >
                  {translate("models.test")}
                </Button>
                <IconButton
                  aria-label={translate("models.deleteProfile")}
                  onClick={() => handleRemove(uid)}
                >
                  <DeleteIcon width={16} height={16} />
                </IconButton>
              </div>
            </div>

            {unsupportedCurrent && (
              <Text className="ev-inline-error">
                {translate("models.thinkingUnsupportedHint", {
                  level: currentThinking,
                  supported: supportedLevels.join(", "),
                })}
              </Text>
            )}

            <Field.Root>
              <Field.Label>{translate("models.profileDescription")}</Field.Label>
              <Input
                type="text"
                value={profile.description}
                placeholder={translate("models.defaultProfileDescription")}
                onValueChange={(value) => onUpdateProfile(uid, { ...profile, description: value })}
              />
            </Field.Root>

            {smoke && !smoke.loading && (smoke.result || smoke.error) && (
              <div className="ev-profile-smoke">
                {smoke.error && <div className="ev-error-banner">{smoke.error}</div>}
                {smoke.result && <SmokeTestResult result={smoke.result} request={smoke.request} />}
                <div>
                  <Button
                    type="button"
                    hierarchy="tertiary"
                    density="compact"
                    onClick={() => cancelTest(String(uid))}
                  >
                    {translate("models.collapseResult")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <Field.Root>
        <Field.Label>{translate("models.notesLabel")}</Field.Label>
        <TextArea
          rows={3}
          value={notes}
          onValueChange={onNotesChange}
          placeholder={translate("models.notesPlaceholder")}
        />
      </Field.Root>
    </Section.Root>
  );
}
