import { DescriptionIcon } from "@earendil-works/elanor-icons-react";
import type { SkillEntry } from "@eevee/protocol";
import type { MutableRefObject } from "react";
import { formatBytes } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import type { MentionOption } from "./useComposerAutocomplete.ts";

export function ComposerAutocompleteMenu({
  skillPopoverOpen,
  mentionPopoverOpen,
  skills,
  matchingSkills,
  loadingSkills,
  skillsError,
  mentionOptions,
  loadingMentions,
  safeIndex,
  optionRefs,
  onHoverIndex,
  onSelectSkill,
  onSelectMention,
}: {
  readonly skillPopoverOpen: boolean;
  readonly mentionPopoverOpen: boolean;
  readonly skills: readonly SkillEntry[];
  readonly matchingSkills: readonly SkillEntry[];
  readonly loadingSkills: boolean;
  readonly skillsError: string | undefined;
  readonly mentionOptions: readonly MentionOption[];
  readonly loadingMentions: boolean;
  readonly safeIndex: number;
  readonly optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  readonly onHoverIndex: (idx: number) => void;
  readonly onSelectSkill: (skill: SkillEntry) => void;
  readonly onSelectMention: (option: MentionOption) => void;
}) {
  const { t } = useI18n();

  if (skillPopoverOpen) {
    return (
      <div className="ev-skill-autocomplete" role="listbox" aria-label={t("composer.skill.title")}>
        {loadingSkills && skills.length === 0 ? (
          <div className="ev-skill-ac-empty">{t("composer.skill.loading")}</div>
        ) : skillsError && skills.length === 0 ? (
          <div className="ev-skill-ac-empty ev-inline-error">{skillsError}</div>
        ) : matchingSkills.length === 0 ? (
          <div className="ev-skill-ac-empty">{t("composer.skill.empty")}</div>
        ) : (
          <div className="ev-skill-ac-list">
            {matchingSkills.map((skill, idx) => (
              <button
                key={`${skill.name}:${skill.path}`}
                ref={(el) => {
                  optionRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                aria-selected={idx === safeIndex}
                className="ev-skill-ac-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex(idx)}
                onClick={() => onSelectSkill(skill)}
              >
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
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (mentionPopoverOpen) {
    return (
      <div
        className="ev-skill-autocomplete"
        role="listbox"
        aria-label={t("composer.mention.title")}
      >
        {loadingMentions && mentionOptions.length === 0 ? (
          <div className="ev-skill-ac-empty">{t("composer.mention.loading")}</div>
        ) : mentionOptions.length === 0 ? (
          <div className="ev-skill-ac-empty">{t("composer.mention.empty")}</div>
        ) : (
          <div className="ev-skill-ac-list">
            {mentionOptions.map((option, idx) => (
              <button
                key={option.key}
                ref={(el) => {
                  optionRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                aria-selected={idx === safeIndex}
                className="ev-skill-ac-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex(idx)}
                onClick={() => onSelectMention(option)}
              >
                {option.kind === "file" ? (
                  <div className="ev-skill-ac-row">
                    <DescriptionIcon width={13} height={13} className="ev-attachment-icon" />
                    <span className="ev-mono ev-skill-ac-name ev-truncate">{option.file.name}</span>
                    {option.file.dir && (
                      <span className="ev-skill-ac-desc ev-truncate">{option.file.dir}</span>
                    )}
                    <span className="ev-attachment-size ev-num ev-push-end">
                      {formatBytes(option.file.size)}
                    </span>
                  </div>
                ) : (
                  <div className="ev-skill-ac-row">
                    <span className="ev-chip-id">@{option.value}</span>
                    <span className="ev-truncate ev-skill-ac-name">{option.label}</span>
                    <span className="eevee-badge ev-push-end">
                      {option.kind === "worker"
                        ? t("composer.mention.group.workers")
                        : t("composer.mention.group.tickets")}
                    </span>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}
