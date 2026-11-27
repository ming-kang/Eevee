import {
  CheckIcon,
  ExpandMoreIcon,
  LightbulbIcon,
  SearchIcon,
  StarIcon,
} from "@earendil-works/elanor-icons-react";
import { KeyValue } from "@earendil-works/elanor-react";
import type { ModelChoice, ModelInfo, ModelSlotsOverride, ThinkingLevel } from "@eevee/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type ComputedPopoverPosition, computePopoverPosition } from "../lib/floating.ts";
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
import { EvTooltip } from "./EvTooltip.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

export type ModelChoiceMenuProps = {
  readonly value: ModelChoice | undefined;
  readonly models: readonly ModelInfo[];
  readonly modelSlots?: ModelSlotsOverride;
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

const POPOVER_DESIRED_WIDTH = 380;
const POPOVER_ESTIMATED_HEIGHT = 260;
const DETAIL_CARD_WIDTH = 250;
const DETAIL_CARD_GAP = 8;

function formatPricePerMillion(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  return `$${value < 1 ? value.toFixed(2) : value.toFixed(2).replace(/\.00$/, "")}`;
}

function assignedRolesForModel(model: ModelInfo, slots: ModelSlotsOverride | undefined): string[] {
  if (!slots) return [];
  const roles: string[] = [];
  if (sameModelChoice(model, slots.router)) roles.push("Router");
  if (sameModelChoice(model, slots.worker)) roles.push("Worker");
  if (sameModelChoice(model, slots.dreamer)) roles.push("Dreamer");
  return roles;
}

export function ModelChoiceMenu({
  value,
  models,
  modelSlots,
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
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const shouldScrollActiveRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => readPinnedModelKeys());
  const [position, setPosition] = useState<ComputedPopoverPosition | undefined>(undefined);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );

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
  const activeRow = flatRows[safeActiveIndex];
  const inspectedModel = activeRow?.kind === "model" ? activeRow.model : undefined;

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      setOpen(false);
      setQuery("");
      return;
    }
    setViewportWidth(window.innerWidth);
    setPosition(
      computePopoverPosition({
        anchor: rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        preferredPlacement: placement,
        preferredAlign: align,
        popoverWidth: Math.max(POPOVER_DESIRED_WIDTH, Math.round(rect.width)),
        estimatedHeight: POPOVER_ESTIMATED_HEIGHT,
      }),
    );
  }, [placement, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    updatePosition();
    const onScroll = (event: Event) => {
      if (
        popoverRef.current &&
        event.target instanceof Node &&
        popoverRef.current.contains(event.target)
      ) {
        return;
      }
      updatePosition();
    };
    window.addEventListener("resize", updatePosition, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [open, updatePosition]);

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
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
      setQuery("");
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const flatRowsRef = useRef(flatRows);
  flatRowsRef.current = flatRows;
  const valueRef = useRef(value);
  valueRef.current = value;

  const isPositioned = position !== undefined;

  useEffect(() => {
    if (!open || !isPositioned) return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, isPositioned]);

  useEffect(() => {
    if (!open) return;
    const initial = flatRowsRef.current.findIndex((row) =>
      row.kind === "clear"
        ? valueRef.current === undefined
        : sameModelChoice(row.model, valueRef.current),
    );
    shouldScrollActiveRef.current = true;
    setActiveIndex(Math.max(0, initial));
  }, [open]);

  useEffect(() => {
    void query;
    shouldScrollActiveRef.current = true;
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open || !isPositioned || !shouldScrollActiveRef.current) return;
    shouldScrollActiveRef.current = false;
    rowRefs.current[safeActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, isPositioned, safeActiveIndex]);

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
      shouldScrollActiveRef.current = true;
      setActiveIndex((prev) => (prev + 1) % flatRows.length);
    } else if (event.key === "ArrowUp") {
      if (flatRows.length === 0) return;
      event.preventDefault();
      shouldScrollActiveRef.current = true;
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

  rowRefs.current.length = flatRows.length;
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
            width={14}
            height={14}
            className="ev-model-menu-meta-icon"
            aria-label={t("modelMenu.reasoning")}
          />
        )}
        <span className="ev-model-menu-meta ev-num">{formatTokens(model.contextWindow)}</span>
        <EvTooltip content={pinned ? t("modelMenu.unpin") : t("modelMenu.pin")} side="top">
          <button
            type="button"
            className={`ev-model-pin-btn${pinned ? " pinned" : ""}`}
            aria-label={pinned ? t("modelMenu.unpin") : t("modelMenu.pin")}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              handleTogglePin(model);
            }}
          >
            <StarIcon width={14} height={14} />
          </button>
        </EvTooltip>
        <span className="ev-model-menu-check" aria-hidden="true">
          {selected && <CheckIcon width={15} height={15} />}
        </span>
      </div>
    );
  };

  const popoverStyle: CSSProperties | undefined = position
    ? {
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        ...(position.top !== undefined ? { top: position.top } : {}),
        ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
      }
    : undefined;

  const canShowDetailCard =
    position !== undefined &&
    inspectedModel !== undefined &&
    viewportWidth >= 820 &&
    (position.left + position.width + DETAIL_CARD_GAP + DETAIL_CARD_WIDTH <= viewportWidth - 8 ||
      position.left - DETAIL_CARD_GAP - DETAIL_CARD_WIDTH >= 8);

  const detailCardLeft =
    position && canShowDetailCard
      ? position.left + position.width + DETAIL_CARD_GAP + DETAIL_CARD_WIDTH <= viewportWidth - 8
        ? position.left + position.width + DETAIL_CARD_GAP
        : position.left - DETAIL_CARD_GAP - DETAIL_CARD_WIDTH
      : undefined;

  const detailCardStyle: CSSProperties | undefined =
    position && detailCardLeft !== undefined
      ? {
          left: detailCardLeft,
          width: DETAIL_CARD_WIDTH,
          ...(position.top !== undefined ? { top: position.top } : {}),
          ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
        }
      : undefined;

  const inspectedRoles = inspectedModel ? assignedRolesForModel(inspectedModel, modelSlots) : [];
  const inspectedCaps: string[] = [];
  if (inspectedModel?.reasoning) inspectedCaps.push(t("modelMenu.reasoning"));
  if (inspectedModel?.input?.includes("image")) inspectedCaps.push(t("modelMenu.vision"));

  const popoverNode =
    open && position ? (
      <>
        <div
          ref={popoverRef}
          id={menuId}
          className={`ev-model-menu-popover placement-${position.placement}`}
          style={popoverStyle}
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
                    className="ev-model-thinking-pill ev-mono"
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
            <SearchIcon width={15} height={15} />
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
                      {selected && <CheckIcon width={15} height={15} />}
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
                <div className="ev-model-menu-group">
                  <ProviderIcon provider={provider} size={12} />
                  <span>{provider}</span>
                </div>
                {list.map((model) => renderModelRow(model, "grp"))}
              </div>
            ))}

            {flatRows.length === 0 && (
              <div className="ev-model-menu-empty">{t("modelMenu.empty")}</div>
            )}
          </div>
        </div>

        {canShowDetailCard && inspectedModel && detailCardStyle && (
          <aside className="ev-model-detail-card" style={detailCardStyle} aria-hidden="true">
            <div className="ev-model-detail-head">
              <ProviderIcon provider={inspectedModel.provider} size={15} />
              <div className="ev-model-detail-titles">
                <div className="ev-truncate ev-model-detail-name">{inspectedModel.name}</div>
                <div className="ev-truncate ev-mono ev-model-detail-id">
                  {inspectedModel.provider}/{inspectedModel.id}
                </div>
              </div>
            </div>

            <KeyValue.Grid className="ev-model-detail-kv">
              <KeyValue.Key>{t("modelMenu.detail.context")}</KeyValue.Key>
              <KeyValue.Value className="ev-mono ev-num">
                {formatTokens(inspectedModel.contextWindow)}
              </KeyValue.Value>
              {inspectedModel.maxTokens > 0 && (
                <>
                  <KeyValue.Key>{t("modelMenu.detail.maxOut")}</KeyValue.Key>
                  <KeyValue.Value className="ev-mono ev-num">
                    {formatTokens(inspectedModel.maxTokens)}
                  </KeyValue.Value>
                </>
              )}
              <KeyValue.Key>{t("modelMenu.detail.inputCost")}</KeyValue.Key>
              <KeyValue.Value className="ev-mono ev-num">
                {formatPricePerMillion(inspectedModel.cost.input)}
              </KeyValue.Value>
              <KeyValue.Key>{t("modelMenu.detail.outputCost")}</KeyValue.Key>
              <KeyValue.Value className="ev-mono ev-num">
                {formatPricePerMillion(inspectedModel.cost.output)}
              </KeyValue.Value>
              {inspectedModel.cost.cacheRead > 0 && (
                <>
                  <KeyValue.Key>{t("modelMenu.detail.cacheRead")}</KeyValue.Key>
                  <KeyValue.Value className="ev-mono ev-num">
                    {formatPricePerMillion(inspectedModel.cost.cacheRead)}
                  </KeyValue.Value>
                </>
              )}
              {inspectedCaps.length > 0 && (
                <>
                  <KeyValue.Key>{t("modelMenu.detail.capabilities")}</KeyValue.Key>
                  <KeyValue.Value>{inspectedCaps.join(" · ")}</KeyValue.Value>
                </>
              )}
              {inspectedRoles.length > 0 && (
                <>
                  <KeyValue.Key>{t("modelMenu.detail.profiles")}</KeyValue.Key>
                  <KeyValue.Value>{inspectedRoles.join(", ")}</KeyValue.Value>
                </>
              )}
            </KeyValue.Grid>
          </aside>
        )}
      </>
    ) : null;

  return (
    <div ref={rootRef} className={`ev-model-menu-root ${variant}`}>
      <EvTooltip content={value ? `${value.provider}/${value.modelId}` : placeholder} side="top">
        <button
          ref={triggerRef}
          type="button"
          className={`ev-model-menu-trigger ${variant}${value === undefined ? " placeholder" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={ariaLabel ?? t("modelMenu.ariaLabel")}
          disabled={disabled || busy}
          onClick={handleToggleOpen}
        >
          {value && <ProviderIcon provider={value.provider} size={14} />}
          <span className="ev-truncate">{displayName}</span>
          {displayThinking && (
            <>
              <span className="ev-model-menu-sep" aria-hidden="true">
                ·
              </span>
              <span className="ev-model-menu-thinking-tag ev-mono">{displayThinking}</span>
            </>
          )}
          {isUnavailable && (
            <span className="eevee-badge" data-tone="warning">
              {t("modelMenu.unavailable")}
            </span>
          )}
          <ExpandMoreIcon width={16} height={16} className="ev-model-menu-caret" />
        </button>
      </EvTooltip>

      {popoverNode &&
        (typeof document === "undefined" ? popoverNode : createPortal(popoverNode, document.body))}
    </div>
  );
}
