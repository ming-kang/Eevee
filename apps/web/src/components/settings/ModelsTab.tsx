import {
  AddIcon,
  DeleteIcon,
  ExperimentIcon,
  RefreshIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Heading,
  IconButton,
  Input,
  Separator,
  Table,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type {
  ModelInfo,
  ModelProfile,
  SmokeTestModelResponse,
  ThinkingLevel,
} from "@eevee/protocol";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatTokens } from "../../lib/format.ts";
import { THINKING_LEVELS } from "./provider-utils.ts";
import { SmokeTestResult } from "./SmokeTestResult.tsx";

const DISPLAY_LIMIT = 100;

type IndexedProfile = {
  readonly uid: number;
  readonly profile: ModelProfile;
};

type ProfileSmokeState = {
  readonly loading: boolean;
  readonly result?: SmokeTestModelResponse;
  readonly error?: string;
};

let nextProfileUid = 1;

function wrapProfiles(list: readonly ModelProfile[]): IndexedProfile[] {
  return list.map((profile) => ({ uid: nextProfileUid++, profile }));
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

export function ModelsTab() {
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [filter, setFilter] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [profiles, setProfiles] = useState<IndexedProfile[]>([]);
  const [notes, setNotes] = useState("");
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [profileTests, setProfileTests] = useState<Record<number, ProfileSmokeState>>({});
  const smokeAbortsRef = useRef<Map<number, AbortController>>(new Map());
  const datalistPrefix = useId();
  const providerListId = `${datalistPrefix}-providers`;

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [modelsRes, profilesRes] = await Promise.all([
        api.listModels(),
        api.getModelProfiles(),
      ]);
      setAllModels(modelsRes.models);
      setProfiles(wrapProfiles(profilesRes.profiles));
      setNotes(profilesRes.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const smokeAborts = smokeAbortsRef.current;
    return () => {
      for (const controller of smokeAborts.values()) controller.abort();
      smokeAborts.clear();
    };
  }, [load]);

  const refreshCatalog = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      await api.refreshModels({ force: true });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const providerIds = useMemo(() => {
    const seen = new Set<string>();
    for (const model of allModels) seen.add(model.provider);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [allModels]);

  const addProfile = () => {
    const first = allModels.find((m) => m.available) ?? allModels[0];
    setProfiles((prev) => [
      ...prev,
      {
        uid: nextProfileUid++,
        profile: {
          id: `profile-${prev.length + 1}`,
          model: {
            provider: first?.provider ?? "openai",
            modelId: first?.id ?? "gpt-4o",
          },
          description: "说明此模型擅长的任务类型与成本特征",
        },
      },
    ]);
    setSavedNotice(false);
  };

  const updateProfile = (uid: number, next: ModelProfile) => {
    setProfiles((prev) =>
      prev.map((item) => (item.uid === uid ? { ...item, profile: next } : item)),
    );
    setSavedNotice(false);
  };

  const removeProfile = (uid: number) => {
    smokeAbortsRef.current.get(uid)?.abort();
    smokeAbortsRef.current.delete(uid);
    setProfileTests((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setProfiles((prev) => prev.filter((item) => item.uid !== uid));
    setSavedNotice(false);
  };

  const saveProfiles = async () => {
    setSavingProfiles(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const res = await api.putModelProfiles({
        profiles: profiles.map((item) => item.profile),
        ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
      });
      setProfiles(wrapProfiles(res.profiles));
      setNotes(res.notes ?? "");
      setSavedNotice(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProfiles(false);
    }
  };

  const runProfileTest = async (uid: number, profile: ModelProfile) => {
    const provider = profile.model.provider.trim();
    const modelId = profile.model.modelId.trim();
    if (!provider || !modelId) return;
    smokeAbortsRef.current.get(uid)?.abort();
    const controller = new AbortController();
    smokeAbortsRef.current.set(uid, controller);
    setProfileTests((prev) => ({ ...prev, [uid]: { loading: true } }));
    try {
      const result = await api.testProviderModel(
        provider,
        modelId,
        profile.model.thinkingLevel ? { thinkingLevel: profile.model.thinkingLevel } : {},
        controller.signal,
      );
      setProfileTests((prev) => ({ ...prev, [uid]: { loading: false, result } }));
    } catch (err) {
      if (!controller.signal.aborted) {
        setProfileTests((prev) => ({
          ...prev,
          [uid]: {
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    }
  };

  const clearProfileTest = (uid: number) => {
    smokeAbortsRef.current.get(uid)?.abort();
    smokeAbortsRef.current.delete(uid);
    setProfileTests((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  };

  const scopedModels = onlyAvailable ? allModels.filter((m) => m.available) : allModels;
  const visibleModels = scopedModels.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q);
  });
  const displayedModels = showAllModels ? visibleModels : visibleModels.slice(0, DISPLAY_LIMIT);

  return (
    <div className="ev-settings-section" style={{ gap: 22 }}>
      {error && <div className="ev-error-banner">{error}</div>}

      <datalist id={providerListId}>
        {providerIds.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>

      <div className="ev-settings-section">
        <div className="ev-settings-head">
          <Heading level={2} size={5}>
            模型画像
          </Heading>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<AddIcon width={15} height={15} />}
              onClick={addProfile}
            >
              添加
            </Button>
            <Button
              hierarchy="primary"
              density="compact"
              pending={savingProfiles}
              onClick={() => void saveProfiles()}
            >
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
          const smoke = profileTests[uid];

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
                    onValueChange={(value) => updateProfile(uid, { ...profile, id: value })}
                  />
                </Field.Root>
                <Field.Root style={{ width: 150 }}>
                  <Field.Label>Provider</Field.Label>
                  <Input
                    type="text"
                    list={providerListId}
                    value={profile.model.provider}
                    onValueChange={(value) =>
                      updateProfile(
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
                      updateProfile(
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
                      updateProfile(uid, {
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
                  onClick={() => void runProfileTest(uid, profile)}
                >
                  测试
                </Button>
                <IconButton aria-label="删除画像" onClick={() => removeProfile(uid)}>
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
                  onValueChange={(value) => updateProfile(uid, { ...profile, description: value })}
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
                      onClick={() => clearProfileTest(uid)}
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
            onValueChange={(value) => {
              setNotes(value);
              setSavedNotice(false);
            }}
            placeholder="各模型适用场景与优先级…"
          />
        </Field.Root>
      </div>

      <Separator />

      <div className="ev-settings-section">
        <div className="ev-settings-head">
          <Heading level={2} size={5}>
            模型目录
            <span
              className="ev-num"
              style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: "var(--ev-fg-subtle)" }}
            >
              {visibleModels.length}
            </span>
          </Heading>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ width: 220 }}>
              <Input
                type="text"
                value={filter}
                onValueChange={(value) => setFilter(value)}
                placeholder="筛选模型…"
              />
            </div>
            <Button
              hierarchy="secondary"
              density="compact"
              onClick={() => setOnlyAvailable((prev) => !prev)}
            >
              {onlyAvailable ? "仅可用" : "全部"}
            </Button>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<RefreshIcon width={15} height={15} />}
              pending={refreshing}
              onClick={() => void refreshCatalog()}
            >
              刷新
            </Button>
          </div>
        </div>

        <Table.Container className="ev-table-frame">
          <Table.Root>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>模型</Table.HeaderCell>
                <Table.HeaderCell>思考档位</Table.HeaderCell>
                <Table.HeaderCell align="end">上下文</Table.HeaderCell>
                <Table.HeaderCell align="end">输出</Table.HeaderCell>
                <Table.HeaderCell align="end">状态</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {visibleModels.length === 0 ? (
                <Table.Row>
                  <Table.Cell
                    colSpan={5}
                    style={{ color: "var(--ev-fg-subtle)", textAlign: "center", paddingBlock: 24 }}
                  >
                    {onlyAvailable ? "无可用模型" : "无匹配模型"}
                  </Table.Cell>
                </Table.Row>
              ) : (
                displayedModels.map((model) => (
                  <Table.Row key={`${model.provider}/${model.id}`}>
                    <Table.Cell>
                      <div className="ev-model-cell">
                        <span className="ev-mono">
                          {model.provider}/{model.id}
                        </span>
                        {model.name !== model.id && (
                          <span className="ev-inline-muted" style={{ fontSize: 12 }}>
                            {model.name}
                          </span>
                        )}
                        <div className="ev-model-badges">
                          {model.isCustom && (
                            <span className="eevee-badge" data-tone="info">
                              自定义
                            </span>
                          )}
                          {!model.isCustom && model.hasOverride && (
                            <span className="eevee-badge" data-tone="warning">
                              已覆盖
                            </span>
                          )}
                          {model.input?.includes("image") && (
                            <span className="eevee-badge">image</span>
                          )}
                          {model.reasoning && <span className="eevee-badge">reasoning</span>}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      {model.supportedThinkingLevels && model.supportedThinkingLevels.length > 0 ? (
                        <div className="ev-thinking-pills">
                          {model.supportedThinkingLevels.map((level) => (
                            <span key={level} className="ev-thinking-pill ev-mono">
                              {level}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="ev-inline-muted">—</span>
                      )}
                    </Table.Cell>
                    <Table.Cell align="end" className="ev-num">
                      {formatTokens(model.contextWindow)}
                    </Table.Cell>
                    <Table.Cell align="end" className="ev-num">
                      {formatTokens(model.maxTokens)}
                    </Table.Cell>
                    <Table.Cell align="end">
                      <span
                        className="eevee-badge"
                        data-tone={model.available ? "positive" : "neutral"}
                      >
                        {model.available ? "可用" : "未认证"}
                      </span>
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table.Root>
        </Table.Container>

        {visibleModels.length > DISPLAY_LIMIT && (
          <div className="ev-table-footer">
            <span className="ev-inline-muted ev-num">
              {showAllModels
                ? `已显示全部 ${visibleModels.length} 个模型`
                : `当前显示前 ${DISPLAY_LIMIT} 个，共 ${visibleModels.length} 个模型`}
            </span>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => setShowAllModels((prev) => !prev)}
            >
              {showAllModels
                ? `收起为前 ${DISPLAY_LIMIT} 个`
                : `显示全部 ${visibleModels.length} 个模型`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
