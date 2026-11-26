import { AddIcon, DeleteIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Card,
  Field,
  Heading,
  IconButton,
  Input,
  Separator,
  Stack,
  Table,
  TextArea,
} from "@earendil-works/elanor-react";
import type { ModelInfo, ModelProfile, ThinkingLevel } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatTokens } from "../../lib/format.ts";

const THINKING_OPTIONS: readonly ("" | ThinkingLevel)[] = [
  "",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

type IndexedProfile = {
  readonly uid: number;
  readonly profile: ModelProfile;
};

let nextProfileUid = 1;

function wrapProfiles(list: readonly ModelProfile[]): IndexedProfile[] {
  return list.map((profile) => ({ uid: nextProfileUid++, profile }));
}

export function ModelsTab() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [profiles, setProfiles] = useState<IndexedProfile[]>([]);
  const [notes, setNotes] = useState("");
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [modelsRes, profilesRes] = await Promise.all([
        api.listModels(onlyAvailable ? { available: true } : undefined),
        api.getModelProfiles(),
      ]);
      setModels(modelsRes.models);
      setProfiles(wrapProfiles(profilesRes.profiles));
      setNotes(profilesRes.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onlyAvailable]);

  useEffect(() => {
    void load();
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

  const addProfile = () => {
    const first = models[0];
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

  const visibleModels = models.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q);
  });

  return (
    <Stack direction="column" gap="large">
      {error && <div className="eevee-error-banner">{error}</div>}

      <Stack direction="column" gap="small">
        <Stack
          direction="row"
          gap="small"
          align="center"
          style={{ justifyContent: "space-between" }}
        >
          <Heading level={2} size={5}>
            模型画像（供 Router 为 Worker 选型）
          </Heading>
          <Stack direction="row" gap="xSmall" align="center">
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<AddIcon width={15} height={15} />}
              onClick={addProfile}
            >
              添加画像
            </Button>
            <Button
              hierarchy="primary"
              density="compact"
              pending={savingProfiles}
              onClick={() => void saveProfiles()}
            >
              保存画像
            </Button>
            {savedNotice && (
              <span className="eevee-badge" data-tone="positive">
                已保存
              </span>
            )}
          </Stack>
        </Stack>

        {profiles.map(({ uid, profile }) => (
          <Card key={uid} style={{ padding: 12 }}>
            <Stack direction="column" gap="xSmall">
              <Stack direction="row" gap="xSmall" align="end" style={{ flexWrap: "wrap" }}>
                <Field.Root style={{ width: 150 }}>
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
                    value={profile.model.provider}
                    onValueChange={(value) =>
                      updateProfile(uid, {
                        ...profile,
                        model: { ...profile.model, provider: value },
                      })
                    }
                  />
                </Field.Root>
                <Field.Root style={{ flex: 1, minWidth: 180 }}>
                  <Field.Label>Model ID</Field.Label>
                  <Input
                    type="text"
                    value={profile.model.modelId}
                    onValueChange={(value) =>
                      updateProfile(uid, {
                        ...profile,
                        model: { ...profile.model, modelId: value },
                      })
                    }
                  />
                </Field.Root>
                <Field.Root style={{ width: 120 }}>
                  <Field.Label>Thinking</Field.Label>
                  <select
                    className="eevee-project-select"
                    value={profile.model.thinkingLevel ?? ""}
                    onChange={(event) => {
                      const val = event.target.value as "" | ThinkingLevel;
                      const { thinkingLevel: _old, ...rest } = profile.model;
                      updateProfile(uid, {
                        ...profile,
                        model: val ? { ...rest, thinkingLevel: val } : rest,
                      });
                    }}
                  >
                    {THINKING_OPTIONS.map((level) => (
                      <option key={level || "default"} value={level}>
                        {level || "默认"}
                      </option>
                    ))}
                  </select>
                </Field.Root>
                <IconButton aria-label="删除画像" onClick={() => removeProfile(uid)}>
                  <DeleteIcon width={16} height={16} />
                </IconButton>
              </Stack>
              <Field.Root>
                <Field.Label>用途描述</Field.Label>
                <Input
                  type="text"
                  value={profile.description}
                  onValueChange={(value) => updateProfile(uid, { ...profile, description: value })}
                />
              </Field.Root>
            </Stack>
          </Card>
        ))}

        <Field.Root>
          <Field.Label>选型补充说明（Notes）</Field.Label>
          <TextArea
            rows={3}
            value={notes}
            onValueChange={(value) => {
              setNotes(value);
              setSavedNotice(false);
            }}
            placeholder="例如：日常编码优先用主力模型，快速脚本/文档校对用轻量模型..."
          />
        </Field.Root>
      </Stack>

      <Separator />

      <Stack direction="column" gap="small">
        <Stack
          direction="row"
          gap="small"
          align="center"
          style={{ justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Heading level={2} size={5}>
            模型目录（{visibleModels.length}）
          </Heading>
          <Stack direction="row" gap="xSmall" align="center">
            <Input
              type="text"
              value={filter}
              onValueChange={(value) => setFilter(value)}
              placeholder="筛选 provider/model..."
            />
            <Button
              hierarchy="secondary"
              density="compact"
              onClick={() => setOnlyAvailable((prev) => !prev)}
            >
              {onlyAvailable ? "仅可用" : "全部模型"}
            </Button>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<RefreshIcon width={15} height={15} />}
              pending={refreshing}
              onClick={() => void refreshCatalog()}
            >
              刷新目录
            </Button>
          </Stack>
        </Stack>

        <Table.Container>
          <Table.Root>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Provider / Model</Table.HeaderCell>
                <Table.HeaderCell align="end">上下文</Table.HeaderCell>
                <Table.HeaderCell align="end">输出上限</Table.HeaderCell>
                <Table.HeaderCell>状态</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {visibleModels.slice(0, 80).map((model) => (
                <Table.Row key={`${model.provider}/${model.id}`}>
                  <Table.Cell>
                    <span className="eevee-mono">
                      {model.provider}/{model.id}
                    </span>
                  </Table.Cell>
                  <Table.Cell align="end">{formatTokens(model.contextWindow)}</Table.Cell>
                  <Table.Cell align="end">{formatTokens(model.maxTokens)}</Table.Cell>
                  <Table.Cell>
                    <span
                      className="eevee-badge"
                      data-tone={model.available ? "positive" : "neutral"}
                    >
                      {model.available ? "可用" : "未认证"}
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.Container>
      </Stack>
    </Stack>
  );
}
