import {
  CheckIcon,
  ChevronRightIcon,
  ExpandMoreIcon,
  SearchIcon,
  StarIcon,
} from "@earendil-works/elanor-icons-react";
import type { ModelChoice, ModelInfo, ThinkingLevel } from "@eevee/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ComputedPopoverPosition,
  type ComputedSubmenuPosition,
  computePopoverPosition,
  computeSubmenuPosition,
  isPointInSafeTriangle,
  type Point2D,
} from "../lib/floating.ts";
import { formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import {
  findModelInfo,
  groupModelsByProvider,
  hasSelectableThinkingLevels,
  modelInfoKey,
  readPinnedModelKeys,
  resolvePinnedModels,
  sameModelChoice,
  selectModelWithThinking,
  switchModelChoice,
  thinkingLevelLocaleKey,
  thinkingLevelsOfModel,
  togglePinnedKey,
  writePinnedModelKeys,
} from "../lib/model-choice.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

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

const POPOVER_DESIRED_WIDTH = 360;
const POPOVER_MAX_WIDTH = 440;
const POPOVER_ESTIMATED_HEIGHT = 260;
const SUBMENU_WIDTH = 156;
const SUBMENU_GAP = 6;
const SAFE_TRIANGLE_HOLD_MS = 180;

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
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const shouldScrollActiveRef = useRef(false);
  const activeRowPointerRef = useRef<Point2D | undefined>(undefined);
  const hoverTimerRef = useRef<number | undefined>(undefined);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [submenuFocusIndex, setSubmenuFocusIndex] = useState<number | null>(null);
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => readPinnedModelKeys());
  const [position, setPosition] = useState<ComputedPopoverPosition | undefined>(undefined);
  const [submenuPosition, setSubmenuPosition] = useState<ComputedSubmenuPosition | undefined>(
    undefined,
  );
  const [submenuHiddenByScroll, setSubmenuHiddenByScroll] = useState(false);

  const currentInfo = useMemo(() => findModelInfo(models, value), [models, value]);
  const hasAnyThinkingModel = useMemo(
    () => models.some((model) => hasSelectableThinkingLevels(model)),
    [models],
  );
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
  const activeModel = activeRow?.kind === "model" ? activeRow.model : undefined;
  const activeThinkingLevels = useMemo(
    () => (hasSelectableThinkingLevels(activeModel) ? thinkingLevelsOfModel(activeModel) : []),
    [activeModel],
  );

  const cancelPendingHover = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      cancelPendingHover();
      activeRowPointerRef.current = undefined;
      setOpen(false);
      setQuery("");
      setSubmenuFocusIndex(null);
      setSubmenuPosition(undefined);
      setSubmenuHiddenByScroll(false);
      if (restoreFocus) {
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [cancelPendingHover],
  );

  useEffect(() => () => cancelPendingHover(), [cancelPendingHover]);

  const updateSubmenuPosition = useCallback(() => {
    if (!open || activeThinkingLevels.length === 0) {
      setSubmenuPosition(undefined);
      setSubmenuHiddenByScroll(false);
      return;
    }
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const parentRect = popoverEl.getBoundingClientRect();
    const rowEl = rowRefs.current[safeActiveIndex];
    const listEl = listRef.current;

    let rowTop = parentRect.top;
    if (rowEl && listEl) {
      const rowRect = rowEl.getBoundingClientRect();
      const listRect = listEl.getBoundingClientRect();
      if (rowRect.bottom <= listRect.top + 2 || rowRect.top >= listRect.bottom - 2) {
        setSubmenuPosition(undefined);
        setSubmenuHiddenByScroll(true);
        return;
      }
      rowTop = Math.max(listRect.top, Math.min(rowRect.top, listRect.bottom - 32));
    }

    setSubmenuHiddenByScroll(false);
    const estimatedHeight = 32 + activeThinkingLevels.length * 32 + 12;
    setSubmenuPosition(
      computeSubmenuPosition({
        parent: {
          left: parentRect.left,
          right: parentRect.right,
          top: parentRect.top,
          bottom: parentRect.bottom,
        },
        rowTop,
        submenuWidth: SUBMENU_WIDTH,
        estimatedHeight,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: SUBMENU_GAP,
      }),
    );
  }, [open, activeThinkingLevels.length, safeActiveIndex]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      closeMenu(false);
      return;
    }
    setPosition(
      computePopoverPosition({
        anchor: rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        preferredPlacement: placement,
        preferredAlign: align,
        popoverWidth: Math.min(
          POPOVER_MAX_WIDTH,
          Math.max(POPOVER_DESIRED_WIDTH, Math.round(rect.width)),
        ),
        estimatedHeight: POPOVER_ESTIMATED_HEIGHT,
      }),
    );
  }, [placement, align, closeMenu]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      setSubmenuPosition(undefined);
      return;
    }
    updatePosition();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (popoverRef.current?.contains(target) || submenuRef.current?.contains(target))
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
      if (
        rootRef.current?.contains(target) ||
        popoverRef.current?.contains(target) ||
        submenuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, closeMenu]);

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
    setSubmenuFocusIndex(null);
  }, [open]);

  useEffect(() => {
    void query;
    shouldScrollActiveRef.current = true;
    setActiveIndex(0);
    setSubmenuFocusIndex(null);
  }, [query]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    if (shouldScrollActiveRef.current) {
      shouldScrollActiveRef.current = false;
      rowRefs.current[safeActiveIndex]?.scrollIntoView({ block: "nearest" });
    }
    updateSubmenuPosition();
  }, [open, position, safeActiveIndex, updateSubmenuPosition]);

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

  const handlePickModelThinking = (model: ModelInfo, level: ThinkingLevel) => {
    onChange(selectModelWithThinking(model, level));
    closeMenu(true);
  };

  const handleTogglePin = (model: ModelInfo) => {
    const next = togglePinnedKey(pinnedKeys, modelInfoKey(model));
    setPinnedKeys(next);
    writePinnedModelKeys(next);
  };

  const activateRow = useCallback(
    (idx: number) => {
      cancelPendingHover();
      setActiveIndex(idx);
      setSubmenuFocusIndex(null);
    },
    [cancelPendingHover],
  );

  const handleRowPointerMove = (idx: number, event: MouseEvent<HTMLDivElement>) => {
    const point: Point2D = { x: event.clientX, y: event.clientY };
    if (idx === safeActiveIndex) {
      activeRowPointerRef.current = point;
      cancelPendingHover();
      return;
    }

    const submenuEl = submenuRef.current;
    const origin = activeRowPointerRef.current;
    if (submenuEl && submenuPosition && origin) {
      const rect = submenuEl.getBoundingClientRect();
      if (
        isPointInSafeTriangle(
          point,
          origin,
          { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          submenuPosition.side,
        )
      ) {
        cancelPendingHover();
        hoverTimerRef.current = window.setTimeout(() => {
          hoverTimerRef.current = undefined;
          activeRowPointerRef.current = point;
          setActiveIndex(idx);
          setSubmenuFocusIndex(null);
        }, SAFE_TRIANGLE_HOLD_MS);
        return;
      }
    }

    activeRowPointerRef.current = point;
    activateRow(idx);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (submenuFocusIndex !== null && activeModel && activeThinkingLevels.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSubmenuFocusIndex((prev) => ((prev ?? 0) + 1) % activeThinkingLevels.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSubmenuFocusIndex(
          (prev) => ((prev ?? 0) - 1 + activeThinkingLevels.length) % activeThinkingLevels.length,
        );
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSubmenuFocusIndex(null);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const chosen = activeThinkingLevels[submenuFocusIndex];
        if (!chosen) return;
        event.preventDefault();
        handlePickModelThinking(activeModel, chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
    }

    if (event.key === "ArrowDown") {
      if (flatRows.length === 0) return;
      event.preventDefault();
      shouldScrollActiveRef.current = true;
      activateRow((safeActiveIndex + 1) % flatRows.length);
    } else if (event.key === "ArrowUp") {
      if (flatRows.length === 0) return;
      event.preventDefault();
      shouldScrollActiveRef.current = true;
      activateRow((safeActiveIndex - 1 + flatRows.length) % flatRows.length);
    } else if (event.key === "ArrowRight") {
      if (!activeModel || activeThinkingLevels.length === 0) return;
      const input = event.currentTarget;
      if (
        input.selectionStart !== null &&
        input.selectionEnd !== null &&
        (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length)
      ) {
        return;
      }
      event.preventDefault();
      const effectiveLevel =
        value?.thinkingLevel ?? (activeThinkingLevels.includes("off") ? "off" : undefined);
      const selectedIdx =
        sameModelChoice(activeModel, value) && effectiveLevel !== undefined
          ? Math.max(0, activeThinkingLevels.indexOf(effectiveLevel))
          : 0;
      setSubmenuFocusIndex(selectedIdx);
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
    value?.thinkingLevel !== undefined &&
    (currentInfo === undefined || hasSelectableThinkingLevels(currentInfo))
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
    const hasThinking = hasSelectableThinkingLevels(model);
    const isActive = idx === safeActiveIndex;
    return (
      <div
        key={key}
        ref={(el) => {
          rowRefs.current[idx] = el;
        }}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        className={`ev-model-menu-row${isActive ? " active" : ""}${selected ? " selected" : ""}`}
        onMouseEnter={(event) => handleRowPointerMove(idx, event)}
        onMouseMove={(event) => handleRowPointerMove(idx, event)}
        onClick={() => handlePickModel(model)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handlePickModel(model);
          }
        }}
      >
        <span className="ev-truncate ev-model-menu-name">{model.name}</span>
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
        {hasAnyThinkingModel && (
          <span className="ev-model-menu-chevron" aria-hidden="true">
            {hasThinking && <ChevronRightIcon width={14} height={14} />}
          </span>
        )}
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

  const submenuStyle: CSSProperties | undefined = submenuPosition
    ? {
        left: submenuPosition.left,
        top: submenuPosition.top,
        width: submenuPosition.width,
        maxHeight: submenuPosition.maxHeight,
      }
    : undefined;

  const isActiveModelSelected = activeModel !== undefined && sameModelChoice(activeModel, value);
  const selectedThinkingLevel = isActiveModelSelected
    ? (value?.thinkingLevel ?? (activeThinkingLevels.includes("off") ? "off" : undefined))
    : undefined;
  const showInlineThinkingFallback =
    open &&
    isPositioned &&
    activeModel !== undefined &&
    activeThinkingLevels.length > 0 &&
    submenuPosition === undefined &&
    !submenuHiddenByScroll;

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

          <div
            ref={listRef}
            className="ev-model-menu-list"
            role="listbox"
            aria-label={t("modelMenu.model")}
            onScroll={updateSubmenuPosition}
          >
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
                    onMouseEnter={(event) => handleRowPointerMove(idx, event)}
                    onMouseMove={(event) => handleRowPointerMove(idx, event)}
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
                    {hasAnyThinkingModel && (
                      <span className="ev-model-menu-chevron" aria-hidden="true" />
                    )}
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

          {showInlineThinkingFallback && activeModel && (
            <div className="ev-model-thinking-footer">
              <span className="ev-model-thinking-label">{t("modelMenu.thinking")}</span>
              <div
                className="ev-model-thinking-pills"
                role="menu"
                aria-label={t("modelMenu.thinking")}
              >
                {activeThinkingLevels.map((level) => {
                  const pressed = selectedThinkingLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={pressed}
                      className="ev-model-thinking-pill ev-mono"
                      onClick={() => handlePickModelThinking(activeModel, level)}
                    >
                      {t(thinkingLevelLocaleKey(level))}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {activeModel && activeThinkingLevels.length > 0 && submenuPosition && submenuStyle && (
          <div
            ref={submenuRef}
            className={`ev-model-thinking-submenu side-${submenuPosition.side}`}
            style={submenuStyle}
            role="menu"
            aria-label={t("modelMenu.thinking")}
            onMouseEnter={cancelPendingHover}
          >
            <div className="ev-model-thinking-submenu-title">{t("modelMenu.thinking")}</div>
            <div className="ev-model-thinking-submenu-list">
              {activeThinkingLevels.map((level, optionIdx) => {
                const selected = selectedThinkingLevel === level;
                const focused = submenuFocusIndex === optionIdx;
                return (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`ev-model-thinking-option ev-mono${focused ? " active" : ""}${selected ? " selected" : ""}`}
                    onMouseEnter={() => setSubmenuFocusIndex(optionIdx)}
                    onMouseLeave={() => setSubmenuFocusIndex(null)}
                    onClick={() => handlePickModelThinking(activeModel, level)}
                  >
                    <span className="ev-truncate">{t(thinkingLevelLocaleKey(level))}</span>
                    <span className="ev-model-menu-check" aria-hidden="true">
                      {selected && <CheckIcon width={14} height={14} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
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
