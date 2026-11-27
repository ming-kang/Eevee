import {
  CheckIcon,
  ChevronRightIcon,
  ExperimentIcon,
  SearchIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Field, Input, Modal, Switch, Text, TextArea } from "@earendil-works/elanor-react";
import type {
  BuiltinFieldDiff,
  BuiltinModelCandidate,
  CompatFieldInfo,
  ModelDetail,
  ProviderDetail,
  SmokeTestModelResponse,
  ThinkingLevel,
  UpsertProviderModelRequest,
} from "@eevee/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { deepEqualJson, isRecord } from "../../lib/object.ts";
import {
  cloneThinkingLevels,
  defaultThinkingLevels,
  formatJson,
  formatKeyValueLines,
  modelInputWithImage,
  normalizeHeaderObject,
  parseFiniteNumber,
  parseJsonObject,
  parseKeyValueLines,
  thinkingLevelsFromMap,
} from "./provider-utils.ts";
import { SmokeTestResult } from "./SmokeTestResult.tsx";
import { ThinkingLevelsEditor } from "./ThinkingLevelsEditor.tsx";

const ADVANCED_KEYS = [
  "headers",
  "samplingParams",
  "promptCache",
  "inputLimits",
  "samplingParamsByThinkingLevel",
] as const;

type AdvancedKey = (typeof ADVANCED_KEYS)[number];

type AdvancedTextState = Record<AdvancedKey, string>;

export type ModelEditorTarget = {
  readonly providerId: string;
  readonly providerApi?: string;
  readonly providerBaseUrl?: string;
  readonly model?: ModelDetail;
};

function initialAdvancedText(model: ModelDetail | undefined): AdvancedTextState {
  return {
    headers: formatJson(model?.headers),
    samplingParams: formatJson(model?.samplingParams),
    promptCache: formatJson(model?.promptCache),
    inputLimits: formatJson(model?.inputLimits),
    samplingParamsByThinkingLevel: formatJson(model?.samplingParamsByThinkingLevel),
  };
}

function serializeCompatField(field: CompatFieldInfo, value: unknown): string {
  if (value === undefined) return "";
  if (field.kind === "number") return typeof value === "number" ? String(value) : String(value);
  if (field.kind === "enum") return typeof value === "string" ? value : String(value);
  if (field.kind === "stringMap") return formatKeyValueLines(value) || formatJson(value);
  if (field.kind === "json") return formatJson(value);
  return "";
}

function initialCompatText(
  model: ModelDetail | undefined,
  effectiveApi: string,
  compatSchemas: Record<string, CompatFieldInfo[]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const compat = isRecord(model?.compat) ? model.compat : undefined;
  for (const field of compatSchemas[effectiveApi] ?? []) {
    result[field.key] = serializeCompatField(field, compat?.[field.key]);
  }
  return result;
}

function removeKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...value };
  delete next[key];
  return next;
}

function candidateKey(candidate: BuiltinModelCandidate): string {
  return `${candidate.providerId}/${candidate.modelId}`;
}

function costNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function ModelEditorModal({
  target,
  compatSchemas,
  onClose,
  onProviderChanged,
}: {
  readonly target: ModelEditorTarget;
  readonly compatSchemas: Record<string, CompatFieldInfo[]>;
  readonly onClose: () => void;
  readonly onProviderChanged: (provider: ProviderDetail) => void;
}) {
  const model = target.model;
  const isCreate = model === undefined;
  const isCustom = isCreate || model.isCustom;
  const initialApi = target.providerApi ?? model?.api ?? "";
  const [modelId, setModelId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [apiValue, setApiValue] = useState("");
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [apiTouched, setApiTouched] = useState(false);
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [contextWindow, setContextWindow] = useState(String(model?.contextWindow ?? 128000));
  const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 8192));
  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);
  const [imageInput, setImageInput] = useState(model?.input.includes("image") ?? false);
  const [costInput, setCostInput] = useState(String(model?.cost.input ?? 0));
  const [costOutput, setCostOutput] = useState(String(model?.cost.output ?? 0));
  const [costCacheRead, setCostCacheRead] = useState(String(model?.cost.cacheRead ?? 0));
  const [costCacheWrite, setCostCacheWrite] = useState(String(model?.cost.cacheWrite ?? 0));
  const [thinkingLevels, setThinkingLevels] = useState(() =>
    model ? cloneThinkingLevels(model.thinkingLevels) : defaultThinkingLevels(),
  );
  const [compatValues, setCompatValues] = useState<Record<string, unknown>>(() => ({
    ...(model?.compat ?? {}),
  }));
  const [compatText, setCompatText] = useState<Record<string, string>>(() =>
    initialCompatText(model, model?.api ?? initialApi, compatSchemas),
  );
  const [compatTouched, setCompatTouched] = useState<Record<string, boolean>>({});
  const [advancedText, setAdvancedText] = useState<AdvancedTextState>(() =>
    initialAdvancedText(model),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [matchOpen, setMatchOpen] = useState(false);
  const [matchQuery, setMatchQuery] = useState(model?.id ?? "");
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | undefined>(undefined);
  const [candidates, setCandidates] = useState<BuiltinModelCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<string | undefined>(undefined);
  const [diffChecked, setDiffChecked] = useState<Record<string, boolean>>({});
  const [matchNotice, setMatchNotice] = useState<string | undefined>(undefined);

  const [testLevel, setTestLevel] = useState<"" | ThinkingLevel>("");
  const [testTools, setTestTools] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SmokeTestModelResponse | undefined>(undefined);
  const [testError, setTestError] = useState<string | undefined>(undefined);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const testAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => testAbortRef.current?.abort(), []);

  const effectiveApi = (apiValue.trim() || model?.api || target.providerApi || "").trim();
  const compatFields = compatSchemas[effectiveApi] ?? [];
  const initialInput = model?.input ?? ["text"];
  const initialCompat = isRecord(model?.compat) ? model.compat : {};

  const markCompatTouched = (key: string) => {
    setCompatTouched((prev) => ({ ...prev, [key]: true }));
  };

  const setCompatBoolean = (key: string, enabled: boolean) => {
    markCompatTouched(key);
    setCompatValues((prev) => ({ ...prev, [key]: enabled }));
  };

  const setCompatEnum = (key: string, value: string) => {
    markCompatTouched(key);
    setCompatValues((prev) => (value ? { ...prev, [key]: value } : removeKey(prev, key)));
  };

  const setCompatTextValue = (key: string, value: string) => {
    markCompatTouched(key);
    setCompatText((prev) => ({ ...prev, [key]: value }));
  };

  const replaceCompat = (value: unknown) => {
    const next = isRecord(value) ? { ...value } : {};
    setCompatValues(next);
    const text: Record<string, string> = {};
    for (const field of compatFields) {
      text[field.key] = serializeCompatField(field, next[field.key]);
    }
    setCompatText(text);
    setCompatTouched({});
  };

  const chooseCandidate = (candidate: BuiltinModelCandidate) => {
    setSelectedCandidate(candidateKey(candidate));
    setDiffChecked(
      Object.fromEntries(
        candidate.diffs.map((diff) => [diff.field, diff.applicable && diff.checked]),
      ),
    );
  };

  const runMatch = async (query = matchQuery) => {
    if (!model) return;
    setMatching(true);
    setMatchError(undefined);
    setMatchNotice(undefined);
    try {
      const response = await api.matchBuiltinModel(target.providerId, model.id, {
        query: query.trim() || model.id,
        limit: 10,
      });
      setCandidates(response.candidates);
      const first = response.candidates[0];
      if (first) chooseCandidate(first);
      else setSelectedCandidate(undefined);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setMatching(false);
    }
  };

  const openMatch = () => {
    setMatchOpen((prev) => !prev);
    setMatchQuery((prev) => prev || modelId);
  };

  const applyDiffValue = (diff: BuiltinFieldDiff) => {
    const value = diff.value;
    if (diff.field === "name" && typeof value === "string") setName(value);
    if (diff.field === "reasoning" && typeof value === "boolean") setReasoning(value);
    if (diff.field === "contextWindow" && typeof value === "number") {
      setContextWindow(String(value));
    }
    if (diff.field === "maxTokens" && typeof value === "number") setMaxTokens(String(value));
    if (diff.field === "input" && Array.isArray(value)) {
      setImageInput(value.includes("image"));
    }
    if (diff.field === "cost" && isRecord(value)) {
      const input = costNumber(value.input);
      const output = costNumber(value.output);
      const cacheRead = costNumber(value.cacheRead);
      const cacheWrite = costNumber(value.cacheWrite);
      if (input !== undefined) setCostInput(String(input));
      if (output !== undefined) setCostOutput(String(output));
      if (cacheRead !== undefined) setCostCacheRead(String(cacheRead));
      if (cacheWrite !== undefined) setCostCacheWrite(String(cacheWrite));
    }
    if (diff.field === "thinkingLevelMap") setThinkingLevels(thinkingLevelsFromMap(value));
    if (diff.field === "compat") replaceCompat(value);
    if (
      diff.field === "inputLimits" ||
      diff.field === "promptCache" ||
      diff.field === "samplingParams" ||
      diff.field === "samplingParamsByThinkingLevel"
    ) {
      setAdvancedText((prev) => ({ ...prev, [diff.field]: formatJson(value) }));
    }
  };

  const applySelectedDiffs = () => {
    const candidate = candidates.find((item) => candidateKey(item) === selectedCandidate);
    if (!candidate) return;
    let count = 0;
    for (const diff of candidate.diffs) {
      if (!diff.applicable || diffChecked[diff.field] !== true) continue;
      applyDiffValue(diff);
      count++;
    }
    setMatchNotice(count > 0 ? `已应用 ${count} 个字段` : "未选择可应用字段");
  };

  const buildCompat = (): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...compatValues };
    for (const field of compatFields) {
      if (compatTouched[field.key] !== true) continue;
      const raw = compatText[field.key] ?? serializeCompatField(field, next[field.key]);
      if (field.kind === "boolean") {
        if (typeof next[field.key] === "boolean") continue;
        next[field.key] = false;
      } else if (field.kind === "enum") {
        const value = next[field.key];
        if (typeof value === "string" && value) continue;
        delete next[field.key];
      } else if (!raw.trim()) {
        delete next[field.key];
      } else if (field.kind === "number") {
        next[field.key] = parseFiniteNumber(raw, `compat.${field.key}`);
      } else if (field.kind === "stringMap") {
        const parsed = parseKeyValueLines(raw, `compat.${field.key}`);
        if (parsed) next[field.key] = parsed;
        else delete next[field.key];
      } else {
        const parsed = parseJsonObject(raw, `compat.${field.key}`);
        if (parsed) next[field.key] = parsed;
        else delete next[field.key];
      }
    }
    return next;
  };

  const buildCost = (): Record<string, unknown> => ({
    input: parseFiniteNumber(costInput, "输入价格"),
    output: parseFiniteNumber(costOutput, "输出价格"),
    cacheRead: parseFiniteNumber(costCacheRead, "缓存读取价格"),
    cacheWrite: parseFiniteNumber(costCacheWrite, "缓存写入价格"),
  });

  const buildAdvanced = (input: UpsertProviderModelRequest) => {
    for (const key of ADVANCED_KEYS) {
      const parsed = parseJsonObject(advancedText[key], key);
      const initialValue = model?.[key];
      if (isCreate) {
        if (parsed !== undefined) {
          if (key === "headers") input.headers = normalizeHeaderObject(parsed, "headers");
          else input[key] = parsed;
        }
      } else if (!deepEqualJson(parsed, initialValue)) {
        if (parsed === undefined) input[key] = null;
        else if (key === "headers") input.headers = normalizeHeaderObject(parsed, "headers");
        else input[key] = parsed;
      }
    }
  };

  const buildRequest = (): UpsertProviderModelRequest => {
    const trimmedId = modelId.trim();
    if (!trimmedId) throw new Error("Model ID 不能为空");
    if (isCreate && !effectiveApi) throw new Error("请选择模型协议 API");
    const nextContextWindow = parseFiniteNumber(contextWindow, "上下文窗口");
    const nextMaxTokens = parseFiniteNumber(maxTokens, "最大输出");
    const fullCost = buildCost();
    const input: UpsertProviderModelRequest = {};
    if (isCreate) input.id = trimmedId;

    const trimmedName = name.trim();
    if (isCreate) input.name = trimmedName || trimmedId;
    else if (trimmedName !== (model?.name ?? "")) input.name = trimmedName ? trimmedName : null;

    if (isCustom) {
      const trimmedApi = apiValue.trim();
      const trimmedBaseUrl = baseUrlValue.trim();
      if (isCreate) {
        if (trimmedApi) input.api = trimmedApi;
        if (trimmedBaseUrl) input.baseUrl = trimmedBaseUrl;
      } else {
        if (apiTouched) input.api = trimmedApi ? trimmedApi : null;
        if (baseUrlTouched) input.baseUrl = trimmedBaseUrl ? trimmedBaseUrl : null;
      }
    }

    if (isCreate || reasoning !== model?.reasoning) input.reasoning = reasoning;
    const nextInput = modelInputWithImage(imageInput);
    if (isCreate || !deepEqualJson(nextInput, initialInput)) input.input = nextInput;
    if (isCreate || nextContextWindow !== model?.contextWindow) {
      input.contextWindow = nextContextWindow;
    }
    if (isCreate || nextMaxTokens !== model?.maxTokens) input.maxTokens = nextMaxTokens;

    const initialCost = {
      input: model?.cost.input ?? 0,
      output: model?.cost.output ?? 0,
      cacheRead: model?.cost.cacheRead ?? 0,
      cacheWrite: model?.cost.cacheWrite ?? 0,
    };
    const costChanged = !deepEqualJson(fullCost, initialCost);
    if (isCreate || (costChanged && isCustom)) input.cost = fullCost;
    else if (costChanged) {
      const patch: Record<string, unknown> = {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        if (!Object.is(fullCost[key], initialCost[key])) patch[key] = fullCost[key];
      }
      input.cost = patch;
    }

    if (isCreate || !deepEqualJson(thinkingLevels, model?.thinkingLevels)) {
      input.thinkingLevels = thinkingLevels;
    }

    const nextCompat = buildCompat();
    if (isCreate) {
      if (Object.keys(nextCompat).length > 0) input.compat = nextCompat;
    } else if (!deepEqualJson(nextCompat, initialCompat)) {
      input.compat = Object.keys(nextCompat).length > 0 ? nextCompat : null;
    }

    buildAdvanced(input);
    return input;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const request = buildRequest();
      const response = isCreate
        ? await api.createProviderModel(target.providerId, request)
        : await api.updateProviderModel(target.providerId, model.id, request);
      onProviderChanged(response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async () => {
    if (!model) return;
    const label = model.isCustom
      ? `删除模型「${model.id}」？`
      : `还原「${model.id}」的内置默认配置？`;
    if (!window.confirm(label)) return;
    setDeleting(true);
    setError(undefined);
    try {
      const response = await api.deleteProviderModel(target.providerId, model.id);
      onProviderChanged(response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const runSmokeTest = async () => {
    if (!model) return;
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTesting(true);
    setTestError(undefined);
    setTestResult(undefined);
    try {
      const response = await api.testProviderModel(
        target.providerId,
        model.id,
        {
          ...(testLevel ? { thinkingLevel: testLevel } : {}),
          ...(testTools ? { testTools: true } : {}),
        },
        controller.signal,
      );
      setTestResult(response);
    } catch (err) {
      if (!controller.signal.aborted) {
        setTestError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  };

  const activeCandidate = candidates.find((item) => candidateKey(item) === selectedCandidate);
  const title = isCreate ? "新增模型" : `编辑模型 · ${model.id}`;

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-editor-dialog">
            <Modal.Title>{title}</Modal.Title>
            <form onSubmit={(event) => void save(event)} className="ev-form-stack">
              <Modal.Body className="ev-editor-body">
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">基础信息</div>
                    <div className="ev-model-form-grid">
                      <Field.Root>
                        <Field.Label>Model ID</Field.Label>
                        <Input
                          type="text"
                          value={modelId}
                          readOnly={!isCreate}
                          onValueChange={(value) => {
                            setModelId(value);
                            if (!model) setMatchQuery(value);
                          }}
                          placeholder="vendor/model-id"
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>显示名称</Field.Label>
                        <Input type="text" value={name} onValueChange={setName} />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>上下文窗口</Field.Label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={contextWindow}
                          onValueChange={setContextWindow}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>最大输出</Field.Label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={maxTokens}
                          onValueChange={setMaxTokens}
                        />
                      </Field.Root>
                      <div className="ev-toggle-field">
                        <span>支持推理</span>
                        <Switch.Root checked={reasoning} onCheckedChange={setReasoning}>
                          <Switch.Thumb />
                        </Switch.Root>
                      </div>
                      <div className="ev-toggle-field">
                        <span>支持图像输入</span>
                        <Switch.Root checked={imageInput} onCheckedChange={setImageInput}>
                          <Switch.Thumb />
                        </Switch.Root>
                      </div>
                      {isCustom && (
                        <>
                          <Field.Root>
                            <Field.Label>独立 API（可选）</Field.Label>
                            <select
                              className="ev-select"
                              value={apiValue}
                              onChange={(event) => {
                                setApiValue(event.target.value);
                                setApiTouched(true);
                              }}
                            >
                              <option value="">
                                {target.providerApi
                                  ? `继承 Provider (${target.providerApi})`
                                  : "选择协议"}
                              </option>
                              {Object.keys(compatSchemas).map((item) => (
                                <option key={item} value={item}>
                                  {item}
                                </option>
                              ))}
                            </select>
                          </Field.Root>
                          <Field.Root>
                            <Field.Label>独立 Base URL（可选）</Field.Label>
                            <Input
                              type="url"
                              value={baseUrlValue}
                              placeholder={
                                target.providerBaseUrl
                                  ? `继承 Provider (${target.providerBaseUrl})`
                                  : "https://api.example.com/v1"
                              }
                              onValueChange={(value) => {
                                setBaseUrlValue(value);
                                setBaseUrlTouched(true);
                              }}
                            />
                            {model?.baseUrl && (
                              <Field.Description>当前生效：{model.baseUrl}</Field.Description>
                            )}
                          </Field.Root>
                        </>
                      )}
                    </div>
                    <div className="ev-cost-grid">
                      <Field.Root>
                        <Field.Label>输入价格 $/M</Field.Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={costInput}
                          onValueChange={setCostInput}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>输出价格 $/M</Field.Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={costOutput}
                          onValueChange={setCostOutput}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>缓存读取 $/M</Field.Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={costCacheRead}
                          onValueChange={setCostCacheRead}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>缓存写入 $/M</Field.Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={costCacheWrite}
                          onValueChange={setCostCacheWrite}
                        />
                      </Field.Root>
                    </div>
                  </section>

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">思考档位</div>
                    <ThinkingLevelsEditor
                      value={thinkingLevels}
                      onChange={setThinkingLevels}
                      reasoning={reasoning}
                      showInheritedBadges={!isCustom}
                    />
                  </section>

                  {isCustom && (
                    <section className="ev-editor-section">
                      <div className="ev-editor-section-head">
                        <div className="ev-editor-section-title">使用内置数据补全</div>
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          disabled={isCreate}
                          onClick={openMatch}
                        >
                          {matchOpen ? "收起" : "搜索内置参考"}
                        </Button>
                      </div>
                      {isCreate && (
                        <Text className="ev-inline-hint">
                          保存自定义模型后，即可从内置模型目录匹配并补全字段。
                        </Text>
                      )}
                      {matchOpen && !isCreate && (
                        <div className="ev-match-panel">
                          <div className="ev-match-search">
                            <Input
                              type="text"
                              value={matchQuery}
                              onValueChange={setMatchQuery}
                              placeholder="搜索内置模型…"
                            />
                            <Button
                              type="button"
                              hierarchy="secondary"
                              density="compact"
                              iconStart={<SearchIcon width={14} height={14} />}
                              pending={matching}
                              onClick={() => void runMatch()}
                            >
                              匹配
                            </Button>
                          </div>
                          {matchError && <div className="ev-error-banner">{matchError}</div>}
                          {matchNotice && (
                            <div>
                              <span className="eevee-badge" data-tone="positive">
                                {matchNotice}
                              </span>
                            </div>
                          )}
                          {candidates.length > 0 && (
                            <div className="ev-match-layout">
                              <div className="ev-match-candidates">
                                {candidates.map((candidate) => (
                                  <button
                                    type="button"
                                    key={candidateKey(candidate)}
                                    className="ev-match-candidate"
                                    data-active={candidateKey(candidate) === selectedCandidate}
                                    onClick={() => chooseCandidate(candidate)}
                                  >
                                    <strong>{candidate.name}</strong>
                                    <span className="ev-mono">
                                      {candidate.providerId}/{candidate.modelId}
                                    </span>
                                    <span className="ev-match-meta">
                                      {candidate.api} · {candidate.tier}
                                    </span>
                                  </button>
                                ))}
                              </div>
                              {activeCandidate && (
                                <div className="ev-diff-list">
                                  {activeCandidate.diffs.map((diff) => {
                                    const checked = diffChecked[diff.field] === true;
                                    return (
                                      <label
                                        key={diff.field}
                                        className="ev-diff-row"
                                        data-muted={!diff.applicable}
                                      >
                                        <input
                                          type="checkbox"
                                          className="ev-native-checkbox"
                                          checked={checked}
                                          disabled={!diff.applicable}
                                          onChange={(event) =>
                                            setDiffChecked((prev) => ({
                                              ...prev,
                                              [diff.field]: event.target.checked,
                                            }))
                                          }
                                        />
                                        <span className="ev-diff-field ev-mono">{diff.field}</span>
                                        {!diff.applicable && (
                                          <span className="eevee-badge" data-tone="neutral">
                                            跨协议只读
                                          </span>
                                        )}
                                        {diff.same && (
                                          <span className="eevee-badge" data-tone="positive">
                                            相同
                                          </span>
                                        )}
                                        <span className="ev-diff-values">
                                          <span>{diff.currentText || "—"}</span>
                                          <span aria-hidden="true">→</span>
                                          <span>{diff.referenceText || "—"}</span>
                                        </span>
                                      </label>
                                    );
                                  })}
                                  <div>
                                    <Button
                                      type="button"
                                      hierarchy="primary"
                                      density="compact"
                                      iconStart={<CheckIcon width={14} height={14} />}
                                      onClick={applySelectedDiffs}
                                    >
                                      应用所选字段
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {!matching && candidates.length === 0 && !matchError && (
                            <Text className="ev-inline-hint">输入关键词后点击「匹配」。</Text>
                          )}
                        </div>
                      )}
                    </section>
                  )}

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">协议兼容（compat）</div>
                    {compatFields.length === 0 ? (
                      <Text className="ev-inline-hint">
                        {effectiveApi ? `${effectiveApi} 没有声明兼容字段。` : "先选择协议 API。"}
                      </Text>
                    ) : (
                      <div className="ev-compat-grid">
                        {compatFields.map((field) => {
                          const value = compatValues[field.key];
                          const text = compatText[field.key] ?? serializeCompatField(field, value);
                          return (
                            <div key={field.key} className="ev-compat-field">
                              <div className="ev-compat-label">
                                <span className="ev-mono">{field.key}</span>
                                {field.note && <span className="ev-compat-note">{field.note}</span>}
                              </div>
                              {field.kind === "boolean" && (
                                <div className="ev-thinking-toggle">
                                  <Switch.Root
                                    checked={value === true}
                                    onCheckedChange={(checked) =>
                                      setCompatBoolean(field.key, checked)
                                    }
                                  >
                                    <Switch.Thumb />
                                  </Switch.Root>
                                  <span>{value === true ? "开启" : "关闭"}</span>
                                </div>
                              )}
                              {field.kind === "enum" && (
                                <select
                                  className="ev-select"
                                  value={typeof value === "string" ? value : ""}
                                  onChange={(event) => setCompatEnum(field.key, event.target.value)}
                                >
                                  <option value="">协议默认</option>
                                  {(field.options ?? []).map((option) => (
                                    <option key={option} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {field.kind === "number" && (
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  value={text}
                                  placeholder="协议默认"
                                  onValueChange={(next) => setCompatTextValue(field.key, next)}
                                />
                              )}
                              {(field.kind === "stringMap" || field.kind === "json") && (
                                <TextArea
                                  rows={field.kind === "json" ? 4 : 3}
                                  monospace={field.kind === "json"}
                                  value={text}
                                  placeholder={
                                    field.kind === "stringMap" ? "KEY=VALUE，每行一条" : "JSON 对象"
                                  }
                                  onValueChange={(next) => setCompatTextValue(field.key, next)}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <details
                      className="ev-tool-disclosure"
                      open={advancedOpen}
                      onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
                    >
                      <summary>
                        <ChevronRightIcon
                          className="ev-tool-disclosure-chevron"
                          width={14}
                          height={14}
                        />
                        <span>高级 JSON</span>
                      </summary>
                      <div className="ev-tool-disclosure-body">
                        {ADVANCED_KEYS.map((key) => (
                          <Field.Root key={key}>
                            <Field.Label>
                              <span className="ev-mono">{key}</span>
                            </Field.Label>
                            <TextArea
                              monospace
                              rows={key === "headers" ? 3 : 5}
                              value={advancedText[key]}
                              placeholder="留空则不设置"
                              onValueChange={(value) =>
                                setAdvancedText((prev) => ({ ...prev, [key]: value }))
                              }
                            />
                          </Field.Root>
                        ))}
                      </div>
                    </details>
                  </section>

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">测试推理连接</div>
                    {!model ? (
                      <Text className="ev-inline-hint">保存模型后即可运行 smoke test。</Text>
                    ) : (
                      <div className="ev-smoke-controls">
                        <select
                          className="ev-select"
                          value={testLevel}
                          onChange={(event) =>
                            setTestLevel(event.target.value as "" | ThinkingLevel)
                          }
                        >
                          <option value="">默认 thinking</option>
                          {model.supportedThinkingLevels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                        <label className="ev-check-row">
                          <input
                            type="checkbox"
                            className="ev-native-checkbox"
                            checked={testTools}
                            onChange={(event) => setTestTools(event.target.checked)}
                          />
                          测试工具调用
                        </label>
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          iconStart={<ExperimentIcon width={14} height={14} />}
                          pending={testing}
                          onClick={() => void runSmokeTest()}
                        >
                          测试连接
                        </Button>
                      </div>
                    )}
                    {testError && <div className="ev-error-banner">{testError}</div>}
                    {testResult && <SmokeTestResult result={testResult} />}
                  </section>
                </div>
              </Modal.Body>
              <Modal.Actions className="ev-editor-actions">
                <div className="ev-editor-actions-start">
                  {model?.isCustom && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      pending={deleting}
                      onClick={() => void removeModel()}
                    >
                      删除模型
                    </Button>
                  )}
                  {model && !model.isCustom && model.hasOverride && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      pending={deleting}
                      onClick={() => void removeModel()}
                    >
                      还原内置默认
                    </Button>
                  )}
                </div>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      取消
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={saving}>
                  保存
                </Button>
              </Modal.Actions>
            </form>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
