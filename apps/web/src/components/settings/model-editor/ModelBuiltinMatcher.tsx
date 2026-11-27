import { CheckIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, Input, Text } from "@earendil-works/elanor-react";
import type { BuiltinFieldDiff, BuiltinModelCandidate, ModelDetail } from "@eevee/protocol";
import { useState } from "react";
import { api } from "../../../lib/api.ts";

function candidateKey(candidate: BuiltinModelCandidate): string {
  return `${candidate.providerId}/${candidate.modelId}`;
}

export type ModelBuiltinMatcherProps = {
  readonly providerId: string;
  readonly model: ModelDetail | undefined;
  readonly modelId: string;
  readonly onApplyDiffs: (diffs: readonly BuiltinFieldDiff[]) => void;
};

export function ModelBuiltinMatcher({
  providerId,
  model,
  modelId,
  onApplyDiffs,
}: ModelBuiltinMatcherProps) {
  const isCreate = model === undefined;
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchQuery, setMatchQuery] = useState(model?.id ?? "");
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | undefined>(undefined);
  const [candidates, setCandidates] = useState<BuiltinModelCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<string | undefined>(undefined);
  const [diffChecked, setDiffChecked] = useState<Record<string, boolean>>({});
  const [matchNotice, setMatchNotice] = useState<string | undefined>(undefined);

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
      const response = await api.matchBuiltinModel(providerId, model.id, {
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

  const activeCandidate = candidates.find((item) => candidateKey(item) === selectedCandidate);

  const applySelectedDiffs = () => {
    if (!activeCandidate) return;
    const selectedDiffs = activeCandidate.diffs.filter(
      (diff) => diff.applicable && diffChecked[diff.field] === true,
    );
    if (selectedDiffs.length > 0) {
      onApplyDiffs(selectedDiffs);
    }
    setMatchNotice(
      selectedDiffs.length > 0 ? `已应用 ${selectedDiffs.length} 个字段` : "未选择可应用字段",
    );
  };

  return (
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
        <Text className="ev-inline-hint">保存自定义模型后，即可从内置模型目录匹配并补全字段。</Text>
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
                      <label key={diff.field} className="ev-diff-row" data-muted={!diff.applicable}>
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
  );
}
