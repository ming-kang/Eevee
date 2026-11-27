import {
  CheckIcon,
  ExpandMoreIcon,
  LightbulbIcon,
  SearchIcon,
  StarIcon,
} from "@earendil-works/elanor-icons-react";
import type { ModelChoice, ModelInfo, ThinkingLevel } from "@eevee/protocol";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import {
  findModelInfo,
  groupModelsByProvider,
  modelInfoKey,
  readPinnedModelKeys,
  resolvePinnedModels,
  sameModelChoice,
  supportedThinkingLevelsOf,
  switchModelChoice,
  thinkingLevelLocaleKey,
  togglePinnedKey,
  withThinkingLevel,
  writePinnedModelKeys,
} from "../lib/model-choice.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";

export type ModelChoiceMenuProps = {
  readonly value: ModelChoice | undefined;
  readonly models: readonly ModelInfo[];
  readonly placeholder: string;
  readonly clearLabel?: string;
  readonly placement?: "up" | "down";
  readonly align?: "start" | "end";
  readonly variant?: "inline" | "field";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly ariaLabel?: string;
  readonly onOpen?: () => void;
  readonly onChange: (next: ModelChoice | undefined) => void;
};

type MenuRow =
  | { readonly kind: "clear"; readonly key: string }
  | { readonly kind: "model"; readonly key: string; readonly model: ModelInfo };

export function ModelChoiceMenu({
  value,
  models,
  placeholder,
  clearLabel,
  placement = "down",
  align = "start",
  variant = "field",
  disabled = false,
  busy = false,
  ariaLabel,
  onOpen,
  onChange,
}: ModelChoiceMenuProps) {
  const { t } = useI18n();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => readPinnedModelKeys());

  const currentInfo = useMemo(() => findModelInfo(models, value), [models, value]);
  const thinkingLevels = useMemo(() => supportedThinkingLevelsOf(models, value), [models, value]);
  const groups = useMemo(() => groupModelsByProvider(models, query), [models, query]);
  const pinnedModels = useMemo(() => resolvePinnedModels(pinnedKeys, models), [pinnedKeys, models]);

  const showClear = clearLabel !== undefined && query.trim() === "";
  const showPinned = query.trim() === "" && pinnedModels.length > 0;

  const flatRows = useMemo<MenuRow[]>(() => {
    const out: MenuRow[] = [];
    if (showClear) out.push({ kind: "clear", key: "__clear__" });
    if (showPinned) {
      for (const model of pinnedModels) {
        out.push({ kind: "model", key: `pin:${modelInfoKey(model)}`, model });
      }
    }
    for (const [, list] of groups) {
      for (const model of list) {
        out.push({ kind: "model", key: `grp:${modelInfoKey(model)}`, model });
      }
    }
    return out;
  }, [showClear, showPinned, pinnedModels, groups]);

  const safeActiveIndex = flatRows.length === 0 ? 0 : Math.min(activeIndex, flatRows.length - 1);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useShortcutLayer({
    id: `model-choice-menu:${menuId}`,
    active: open,
    priority: SHORTCUT_PRIORITY.MODAL,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      closeMenu(true);
      return true;
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const flatRowsRef = useRef(flatRows);
  flatRowsRef.current = flatRows;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!open) return;
    const initial = flatRowsRef.current.findIndex((row) =>
      row.kind === "clear"
        ? valueRef.current === undefined
        : sameModelChoice(row.model, valueRef.current),
    );
    setActiveIndex(Math.max(0, initial));
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    void query;
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    rowRefs.current[safeActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, safeActiveIndex]);

  const handleToggleOpen = () => {
    if (disabled) return;
    if (open) {
      closeMenu(false);
    } else {
      onOpen?.();
      setOpen(true);
    }
  };

  const handlePickModel = (model: ModelInfo) => {
    onChange(switchModelChoice(value, model));
    closeMenu(true);
  };

  const handleClear = () => {
    onChange(undefined);
    closeMenu(true);
  };

  const handlePickThinking = (level: ThinkingLevel | undefined) => {
    if (!value) return;
    onChange(withThinkingLevel(value, level));
    closeMenu(true);
  };

  const handleTogglePin = (model: ModelInfo) => {
    const next = togglePinnedKey(pinnedKeys, modelInfoKey(model));
    setPinnedKeys(next);
    writePinnedModelKeys(next);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      if (flatRows.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % flatRows.length);
    } else if (event.key === "ArrowUp") {
      if (flatRows.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + flatRows.length) % flatRows.length);
    } else if (event.key === "Enter") {
      const target = flatRows[safeActiveIndex];
      if (!target) return;
      event.preventDefault();
      if (target.kind === "clear") handleClear();
      else handlePickModel(target.model);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  };

  const displayName = value
    ? (currentInfo?.name ?? `${value.provider}/${value.modelId}`)
    : placeholder;
  const displayThinking =
    value && thinkingLevels.length > 0 && value.thinkingLevel
      ? t(thinkingLevelLocaleKey(value.thinkingLevel))
      : undefined;
  const isUnavailable = value !== undefined && models.length > 0 && currentInfo === undefined;

  let rowCursor = 0;

  const renderModelRow = (model: ModelInfo, prefix: "pin" | "grp") => {
    const idx = rowCursor++;
    const key = `${prefix}:${modelInfoKey(model)}`;
    const selected = sameModelChoice(model, value);
    const pinned = pinnedKeys.includes(modelInfoKey(model));
    return (
      <div
        key={key}
        ref={(el) => {
          rowRefs.current[idx] = el;
        }}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        className={`ev-model-menu-row${idx === safeActiveIndex ? " active" : ""}${selected ? " selected" : ""}`}
        title={`${model.provider}/${model.id}`}
        onMouseEnter={() => setActiveIndex(idx)}
        onClick={() => handlePickModel(model)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handlePickModel(model);
          }
        }}
      >
        <span className="ev-truncate ev-model-menu-name">{model.name}</span>
        {model.reasoning && (
          <LightbulbIcon
            width={13}
            height={13}
            className="ev-model-menu-meta-icon"
            aria-label={t("modelMenu.reasoning")}
          />
        )}
        <span className="ev-model-menu-meta ev-num">{formatTokens(model.contextWindow)}</span>
        <button
          type="button"
          className={`ev-model-pin-btn${pinned ? " pinned" : ""}`}
          aria-label={pinned ? t("modelMenu.unpin") : t("modelMenu.pin")}
          title={pinned ? t("modelMenu.unpin") : t("modelMenu.pin")}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            handleTogglePin(model);
          }}
        >
          <StarIcon width={13} height={13} />
        </button>
        <span className="ev-model-menu-check" aria-hidden="true">
          {selected && <CheckIcon width={14} height={14} />}
        </span>
      </div>
    );
  };

  return (
    <div ref={rootRef} className={`ev-model-menu-root ${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`ev-model-menu-trigger ${variant}${value === undefined ? " placeholder" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel ?? t("modelMenu.ariaLabel")}
        disabled={disabled || busy}
        title={value ? `${value.provider}/${value.modelId}` : placeholder}
        onClick={handleToggleOpen}
      >
        <span className="ev-truncate">{displayName}</span>
        {displayThinking && (
          <>
            <span className="ev-model-menu-sep" aria-hidden="true">
              ·
            </span>
            <span className="ev-model-menu-thinking-tag">{displayThinking}</span>
          </>
        )}
        {isUnavailable && (
          <span className="eevee-badge" data-tone="warning">
            {t("modelMenu.unavailable")}
          </span>
        )}
        <ExpandMoreIcon width={15} height={15} className="ev-model-menu-caret" />
      </button>

      {open && (
        <div
          id={menuId}
          className={`ev-model-menu-popover placement-${placement} align-${align}`}
          role="dialog"
          aria-label={ariaLabel ?? t("modelMenu.ariaLabel")}
        >
          {value && thinkingLevels.length > 0 && (
            <div className="ev-model-thinking-bar">
              <span className="ev-model-thinking-label">{t("modelMenu.thinking")}</span>
              <fieldset
                className="ev-model-thinking-pills"
                aria-label={t("modelMenu.thinking")}
                style={{ border: 0, margin: 0, padding: 0 }}
              >
                <button
                  type="button"
                  className="ev-model-thinking-pill"
                  aria-pressed={value.thinkingLevel === undefined}
                  onClick={() => handlePickThinking(undefined)}
                >
                  {t("common.default")}
                </button>
                {thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className="ev-model-thinking-pill"
                    aria-pressed={value.thinkingLevel === level}
                    onClick={() => handlePickThinking(level)}
                  >
                    {t(thinkingLevelLocaleKey(level))}
                  </button>
                ))}
              </fieldset>
            </div>
          )}

          <div className="ev-model-menu-search">
            <SearchIcon width={14} height={14} />
            <input
              ref={searchRef}
              type="search"
              className="ev-raw-input"
              value={query}
              placeholder={t("modelMenu.searchPlaceholder")}
              aria-label={t("modelMenu.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>

          <div className="ev-model-menu-list" role="listbox" aria-label={t("modelMenu.model")}>
            {showClear &&
              (() => {
                const idx = rowCursor++;
                const selected = value === undefined;
                return (
                  <div
                    key="__clear__"
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    className={`ev-model-menu-row${idx === safeActiveIndex ? " active" : ""}${selected ? " selected" : ""}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={handleClear}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleClear();
                      }
                    }}
                  >
                    <span className="ev-truncate ev-model-menu-name">{clearLabel}</span>
                    <span className="ev-model-menu-check" aria-hidden="true">
                      {selected && <CheckIcon width={14} height={14} />}
                    </span>
                  </div>
                );
              })()}

            {showPinned && (
              <>
                <div className="ev-model-menu-group">{t("modelMenu.pinned")}</div>
                {pinnedModels.map((model) => renderModelRow(model, "pin"))}
              </>
            )}

            {groups.map(([provider, list]) => (
              <div key={provider}>
                <div className="ev-model-menu-group">{provider}</div>
                {list.map((model) => renderModelRow(model, "grp"))}
              </div>
            ))}

            {flatRows.length === 0 && (
              <div className="ev-model-menu-empty">{t("modelMenu.empty")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
