import { useCallback, useEffect, useState } from "react";

export type ShellLayoutState = {
  readonly sideWidth: number;
  readonly railWidth: number;
  readonly effectiveSideWidth: number;
  readonly effectiveRailWidth: number;
  readonly sideCollapsed: boolean;
  readonly railCollapsed: boolean;
  readonly sideDrawerMode: boolean;
  readonly railDrawerMode: boolean;
  readonly sideVisible: boolean;
  readonly railVisible: boolean;
  readonly drawer: "side" | "rail" | null;
  readonly setSideWidth: (w: number) => void;
  readonly setRailWidth: (w: number) => void;
  readonly resetSideWidth: () => void;
  readonly resetRailWidth: () => void;
  readonly toggleSide: () => void;
  readonly toggleRail: () => void;
  readonly openRail: () => void;
  readonly closeDrawer: () => void;
};

export const SIDE_DRAWER_BP = 760;
export const RAIL_DRAWER_BP = 1200;
export const MAIN_MIN_WIDTH = 480;

const SIDE_DEFAULT = 268;
const SIDE_MIN = 210;
const SIDE_MAX = 400;
const RAIL_DEFAULT = 388;
const RAIL_MIN = 300;
const RAIL_MAX = 640;

function readNum(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

function currentViewportWidth(): number {
  return typeof window !== "undefined" ? window.innerWidth : 1440;
}

export function isSideDrawerViewport(viewportWidth: number): boolean {
  return viewportWidth <= SIDE_DRAWER_BP;
}

export function isRailDrawerViewport(viewportWidth: number): boolean {
  return viewportWidth <= RAIL_DRAWER_BP;
}

export function clampSide(w: number, viewportWidth = currentViewportWidth()): number {
  const maxByViewport = Math.max(SIDE_MIN, Math.floor(viewportWidth * 0.34));
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, maxByViewport, Math.round(w)));
}

export function clampRail(
  w: number,
  viewportWidth = currentViewportWidth(),
  dockedSideWidth = 0,
): number {
  const maxByViewport = Math.max(
    RAIL_MIN,
    Math.min(Math.floor(viewportWidth * 0.42), viewportWidth - dockedSideWidth - MAIN_MIN_WIDTH),
  );
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, maxByViewport, Math.round(w)));
}

export function resolveEffectivePanelWidths({
  sideWidth,
  railWidth,
  sideCollapsed,
  railCollapsed,
  withRail,
  viewportWidth,
}: {
  readonly sideWidth: number;
  readonly railWidth: number;
  readonly sideCollapsed: boolean;
  readonly railCollapsed: boolean;
  readonly withRail: boolean;
  readonly viewportWidth: number;
}): { readonly effectiveSideWidth: number; readonly effectiveRailWidth: number } {
  const sideDocked = !isSideDrawerViewport(viewportWidth) && !sideCollapsed;
  const railDocked = withRail && !isRailDrawerViewport(viewportWidth) && !railCollapsed;

  let effectiveSideWidth = clampSide(sideWidth, viewportWidth);
  let effectiveRailWidth = clampRail(railWidth, viewportWidth, sideDocked ? effectiveSideWidth : 0);

  if (sideDocked && railDocked) {
    const available = Math.max(SIDE_MIN + RAIL_MIN, viewportWidth - MAIN_MIN_WIDTH);
    const total = effectiveSideWidth + effectiveRailWidth;
    if (total > available) {
      const overflow = total - available;
      const railReducible = Math.max(0, effectiveRailWidth - RAIL_MIN);
      const railCut = Math.min(overflow, railReducible);
      effectiveRailWidth -= railCut;
      const remaining = overflow - railCut;
      if (remaining > 0) {
        effectiveSideWidth = Math.max(SIDE_MIN, effectiveSideWidth - remaining);
      }
    }
  }

  return { effectiveSideWidth, effectiveRailWidth };
}

export function useShellLayout(withRail = true): ShellLayoutState {
  const [viewportWidth, setViewportWidth] = useState(currentViewportWidth);
  const [sideWidth, setSideWidthState] = useState(() =>
    clampSide(readNum("eevee.sideW", SIDE_DEFAULT)),
  );
  const [railWidth, setRailWidthState] = useState(() =>
    clampRail(readNum("eevee.railW", RAIL_DEFAULT)),
  );
  const [sideCollapsed, setSideCollapsed] = useState(() => readBool("eevee.sideCollapsed", false));
  const [railCollapsed, setRailCollapsed] = useState(() => readBool("eevee.railCollapsed", false));
  const [drawer, setDrawer] = useState<"side" | "rail" | null>(null);

  useEffect(() => {
    const onResize = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      setDrawer((prev) => {
        if (prev === "side" && !isSideDrawerViewport(width)) return null;
        if (prev === "rail" && !isRailDrawerViewport(width)) return null;
        return prev;
      });
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const sideDrawerMode = isSideDrawerViewport(viewportWidth);
  const railDrawerMode = isRailDrawerViewport(viewportWidth);
  const sideVisible = sideDrawerMode ? drawer === "side" : !sideCollapsed;
  const railVisible = railDrawerMode ? drawer === "rail" : !railCollapsed;

  const { effectiveSideWidth, effectiveRailWidth } = resolveEffectivePanelWidths({
    sideWidth,
    railWidth,
    sideCollapsed,
    railCollapsed,
    withRail,
    viewportWidth,
  });

  const setSideWidth = useCallback((w: number) => {
    const clamped = clampSide(w);
    setSideWidthState(clamped);
    writePref("eevee.sideW", String(clamped));
  }, []);

  const setRailWidth = useCallback(
    (w: number) => {
      const dockedSide = !isSideDrawerViewport(window.innerWidth) && !sideCollapsed ? sideWidth : 0;
      const clamped = clampRail(w, window.innerWidth, dockedSide);
      setRailWidthState(clamped);
      writePref("eevee.railW", String(clamped));
    },
    [sideCollapsed, sideWidth],
  );

  const resetSideWidth = useCallback(() => setSideWidth(SIDE_DEFAULT), [setSideWidth]);
  const resetRailWidth = useCallback(() => setRailWidth(RAIL_DEFAULT), [setRailWidth]);

  const toggleSide = useCallback(() => {
    if (isSideDrawerViewport(window.innerWidth)) {
      setDrawer((prev) => (prev === "side" ? null : "side"));
      return;
    }
    setSideCollapsed((prev) => {
      const next = !prev;
      writePref("eevee.sideCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    if (isRailDrawerViewport(window.innerWidth)) {
      setDrawer((prev) => (prev === "rail" ? null : "rail"));
      return;
    }
    setRailCollapsed((prev) => {
      const next = !prev;
      writePref("eevee.railCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const openRail = useCallback(() => {
    if (isRailDrawerViewport(window.innerWidth)) {
      setDrawer("rail");
      return;
    }
    setRailCollapsed(false);
    writePref("eevee.railCollapsed", "0");
  }, []);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  return {
    sideWidth,
    railWidth,
    effectiveSideWidth,
    effectiveRailWidth,
    sideCollapsed,
    railCollapsed,
    sideDrawerMode,
    railDrawerMode,
    sideVisible,
    railVisible,
    drawer,
    setSideWidth,
    setRailWidth,
    resetSideWidth,
    resetRailWidth,
    toggleSide,
    toggleRail,
    openRail,
    closeDrawer,
  };
}
