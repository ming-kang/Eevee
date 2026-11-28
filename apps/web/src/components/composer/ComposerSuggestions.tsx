import { DescriptionIcon } from "@earendil-works/elanor-icons-react";
import { Composer } from "@earendil-works/elanor-react";
import type { BoardViewPayload } from "@eevee/protocol";
import type { ReactNode } from "react";
import {
  chipForItem,
  SUGGESTION_TRIGGERS,
  type SuggestionItem,
} from "../../lib/composer-suggestions.ts";
import { isInsideCode, type MessageChip, type MessageValue } from "../../lib/composer-value.ts";
import { formatBytes } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { type SuggestionState, useSuggestionResults } from "./useSuggestionResults.ts";

const selectValue = (value: MessageValue) => value;

function SuggestionContent({ item }: { readonly item: SuggestionItem }) {
  const { t } = useI18n();
  switch (item.kind) {
    case "skill": {
      const { skill } = item;
      return (
        <>
          <div className="ev-skill-ac-row">
            <span className="ev-mono ev-skill-ac-name">/skill:{skill.name}</span>
            {skill.effectiveMode === "user" && (
              <span className="eevee-badge" data-tone="warning">
                {t("composer.skill.userOnly")}
              </span>
            )}
            <span
              className="eevee-badge"
              data-tone={skill.source === "workspace" ? "info" : undefined}
            >
              {skill.source === "workspace"
                ? t("composer.skill.workspace")
                : t("composer.skill.global")}
            </span>
          </div>
          {skill.description && (
            <div className="ev-skill-ac-desc ev-truncate">{skill.description}</div>
          )}
        </>
      );
    }
    case "file":
      return (
        <div className="ev-skill-ac-row">
          <DescriptionIcon width={13} height={13} className="ev-attachment-icon" />
          <span className="ev-mono ev-skill-ac-name ev-truncate">{item.file.name}</span>
          {item.file.dir && <span className="ev-skill-ac-desc ev-truncate">{item.file.dir}</span>}
          <span className="ev-attachment-size ev-num ev-push-end">
            {formatBytes(item.file.size)}
          </span>
        </div>
      );
    case "worker":
      return (
        <div className="ev-skill-ac-row">
          <span className="ev-chip-id">@{item.worker.id}</span>
          <span className="ev-truncate ev-skill-ac-name">{item.worker.name}</span>
          <span className="eevee-badge ev-push-end">{t("composer.mention.group.workers")}</span>
        </div>
      );
    case "ticket":
      return (
        <div className="ev-skill-ac-row">
          <span className="ev-chip-id">@{item.ticket.id}</span>
          <span className="ev-truncate ev-skill-ac-name">{item.ticket.title}</span>
          <span className="eevee-badge ev-push-end">{t("composer.mention.group.tickets")}</span>
        </div>
      );
  }
}

function emptyMessage(state: SuggestionState, t: ReturnType<typeof useI18n>["t"]): ReactNode {
  const { target } = state;
  if (!target) return null;
  if (target.kind === "mention") {
    return state.loading ? t("composer.mention.loading") : t("composer.mention.empty");
  }
  if (state.loading) return t("composer.skill.loading");
  if (state.error) return <span className="ev-inline-error">{state.error}</span>;
  return target.explicit ? t("composer.skill.empty") : null;
}

export function ComposerSuggestions({
  projectId,
  board,
}: {
  readonly projectId: string | undefined;
  readonly board: BoardViewPayload | undefined;
}) {
  const { t } = useI18n();
  const { insert } = Composer.useActions<MessageChip>();
  const value = Composer.useValue(selectValue);
  const match = Composer.useSuggestionMatch(SUGGESTION_TRIGGERS);
  const activeMatch = match && !isInsideCode(value, match.range) ? match : null;
  const state = useSuggestionResults(projectId, board, activeMatch);
  const empty = emptyMessage(state, t);

  return (
    <Composer.Suggestions
      match={activeMatch}
      results={state.results}
      onItemPick={(item, picked, { event }) => {
        insert(chipForItem(item), { at: picked.range, reason: "item-press", event, space: true });
      }}
      onOpenChange={(open) => {
        if (!open) state.cancel();
      }}
    >
      <Composer.SuggestionStatus>
        {({ count, loading }) =>
          loading
            ? t("composer.suggest.loading")
            : count === 0
              ? t("composer.suggest.none")
              : t("composer.suggest.count", { count })
        }
      </Composer.SuggestionStatus>
      <Composer.SuggestionPortal>
        <Composer.SuggestionPositioner>
          <Composer.SuggestionPopup className="ev-suggest-popup">
            <Composer.SuggestionList
              className="ev-suggest-list"
              aria-label={
                state.target?.kind === "skill"
                  ? t("composer.skill.title")
                  : t("composer.mention.title")
              }
            >
              {state.results?.items.map((item, index) => (
                <Composer.SuggestionItem key={item.key} index={index} className="ev-suggest-item">
                  <SuggestionContent item={item} />
                </Composer.SuggestionItem>
              ))}
            </Composer.SuggestionList>
            {empty !== null && (
              <Composer.SuggestionEmpty className="ev-skill-ac-empty">
                {empty}
              </Composer.SuggestionEmpty>
            )}
          </Composer.SuggestionPopup>
        </Composer.SuggestionPositioner>
      </Composer.SuggestionPortal>
    </Composer.Suggestions>
  );
}
