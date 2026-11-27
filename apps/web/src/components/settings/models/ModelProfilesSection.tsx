import { AddIcon, DeleteIcon, ExperimentIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Heading,
  IconButton,
  Input,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import {
  type ModelInfo,
  type ModelProfile,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@eevee/protocol";
import { useId, useMemo } from "react";
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
      model: {
        provider: first?.provider ?? "openai",
        modelId: first?.id ?? "gpt-4o",
      },
      description: "说明此模型擅长的任务类型与成本特征",
    },
  };
}

function updateProfileModel(
  profile: ModelProfile,
  nextProvider: string,
  nextModelId: string,
  allModels: readonly ModelInfo[],
): ModelProfile {
  const matched = allModels.find(
    (item) => item.provider === nextProvider.trim() && item.id === nextModelId.trim(),
  );
  const currentThinking = profile.model.thinkingLevel;
  const keepThinking =
    currentThinking !== undefined &&
    (!matched?.supportedThinkingLevels ||
      matched.supportedThinkingLevels.includes(currentThinking));
  return {
    ...profile,
    model: {
      provider: nextProvider,
      modelId: nextModelId,
      ...(keepThinking && currentThinking !== undefined ? { thinkingLevel: currentThinking } : {}),
    },
  };
}

export type ModelProfilesSectionProps = {
  readonly allModels: readonly ModelInfo[];
  readonly profiles: readonly IndexedProfile[];
  readonly notes: string;
  readonly saving: boolean;
  readonly savedNotice: boolean;
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
  savedNotice,
  onAddProfile,
  onUpdateProfile,
  onRemoveProfile,
  onNotesChange,
  onSave,
}: ModelProfilesSectionProps) {
  const { tests: profileTests, runTest: runSmokeTest, cancelTest } = useModelSmokeTests();
  const datalistPrefix = useId();
  const providerListId = `${datalistPrefix}-providers`;

  const providerIds = useMemo(() => {
    const seen = new Set<string>();
    for (const model of allModels) seen.add(model.provider);
    return [...seen].sort((a, b) => a.localeCompare(b));
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
    <div className="ev-settings-section">
      <datalist id={providerListId}>
        {providerIds.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>

      <div className="ev-settings-head">
        <Heading level={2} size={5}>
          模型画像
        </Heading>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={onAddProfile}
          >
            添加
          </Button>
          <Button hierarchy="primary" density="compact" pending={saving} onClick={onSave}>
            保存
          </Button>
          {savedNotice && (
            <span className="eevee-badge" data-tone="positive">
              已保存
            </span>
          )}
        </div>
      </div>

      {profiles.map(({ uid, profile }) => {
        const providerValue = profile.model.provider.trim();
        const modelIdValue = profile.model.modelId.trim();
        const providerModels = providerValue
          ? allModels.filter((item) => item.provider === providerValue)
          : [];
        const modelSuggestions = providerModels.length > 0 ? providerModels : allModels;
        const uniqueModelIds = Array.from(new Set(modelSuggestions.map((item) => item.id)));
        const matchedModel = allModels.find(
          (item) => item.provider === providerValue && item.id === modelIdValue,
        );
        const supportedLevels = matchedModel?.supportedThinkingLevels;
        const thinkingChoices = supportedLevels ?? THINKING_LEVELS;
        const currentThinking = profile.model.thinkingLevel;
        const unsupportedCurrent =
          currentThinking !== undefined &&
          supportedLevels !== undefined &&
          !supportedLevels.includes(currentThinking);
        const modelListId = `${datalistPrefix}-models-${uid}`;
        const smoke = profileTests[String(uid)];

        return (
          <div key={uid} className="ev-settings-card">
            <datalist id={modelListId}>
              {uniqueModelIds.map((id) => {
                const candidate = modelSuggestions.find((item) => item.id === id);
                return (
                  <option
                    key={id}
                    value={id}
                    label={
                      candidate ? `${candidate.provider}/${candidate.id} · ${candidate.name}` : id
                    }
                  />
                );
              })}
            </datalist>

            <div className="ev-profile-row">
              <Field.Root style={{ width: 140 }}>
                <Field.Label>画像 ID</Field.Label>
                <Input
                  type="text"
                  value={profile.id}
                  onValueChange={(value) => onUpdateProfile(uid, { ...profile, id: value })}
                />
              </Field.Root>
              <Field.Root style={{ width: 150 }}>
                <Field.Label>Provider</Field.Label>
                <Input
                  type="text"
                  list={providerListId}
                  value={profile.model.provider}
                  onValueChange={(value) =>
                    onUpdateProfile(
                      uid,
                      updateProfileModel(profile, value, profile.model.modelId, allModels),
                    )
                  }
                />
              </Field.Root>
              <Field.Root style={{ flex: 1, minWidth: 180 }}>
                <Field.Label>Model ID</Field.Label>
                <Input
                  type="text"
                  list={modelListId}
                  value={profile.model.modelId}
                  onValueChange={(value) =>
                    onUpdateProfile(
                      uid,
                      updateProfileModel(profile, profile.model.provider, value, allModels),
                    )
                  }
                />
              </Field.Root>
              <Field.Root style={{ width: 130 }}>
                <Field.Label>Thinking</Field.Label>
                <select
                  className="ev-select"
                  value={currentThinking ?? ""}
                  onChange={(event) => {
                    const val = event.target.value as "" | ThinkingLevel;
                    const { thinkingLevel: _old, ...rest } = profile.model;
                    onUpdateProfile(uid, {
                      ...profile,
                      model: val ? { ...rest, thinkingLevel: val } : rest,
                    });
                  }}
                >
                  <option value="">默认</option>
                  {unsupportedCurrent && (
                    <option value={currentThinking}>{currentThinking}（不支持）</option>
                  )}
                  {thinkingChoices.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Field.Root>
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                iconStart={<ExperimentIcon width={14} height={14} />}
                disabled={!providerValue || !modelIdValue}
                pending={smoke?.loading === true}
                onClick={() => runProfileTest(uid, profile)}
              >
                测试
              </Button>
              <IconButton aria-label="删除画像" onClick={() => handleRemove(uid)}>
                <DeleteIcon width={16} height={16} />
              </IconButton>
            </div>

            {unsupportedCurrent && (
              <Text className="ev-inline-error">
                当前 thinkingLevel「{currentThinking}」不在该模型支持的档位列表（
                {supportedLevels.join(", ")}）中。
              </Text>
            )}

            <Field.Root>
              <Field.Label>用途描述</Field.Label>
              <Input
                type="text"
                value={profile.description}
                onValueChange={(value) => onUpdateProfile(uid, { ...profile, description: value })}
              />
            </Field.Root>

            {smoke && !smoke.loading && (smoke.result || smoke.error) && (
              <div className="ev-profile-smoke">
                {smoke.error && <div className="ev-error-banner">{smoke.error}</div>}
                {smoke.result && <SmokeTestResult result={smoke.result} />}
                <div>
                  <Button
                    type="button"
                    hierarchy="tertiary"
                    density="compact"
                    onClick={() => cancelTest(String(uid))}
                  >
                    收起结果
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <Field.Root style={{ width: "100%" }}>
        <Field.Label>补充说明</Field.Label>
        <TextArea
          rows={3}
          value={notes}
          onValueChange={onNotesChange}
          placeholder="各模型适用场景与优先级…"
        />
      </Field.Root>
    </div>
  );
}
