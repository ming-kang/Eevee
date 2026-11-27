import { useCallback, useEffect, useState } from "react";

export type ShellLayoutState = {
  readonly sideWidth: number;
  readonly railWidth: number;
  readonly sideCollapsed: boolean;
  readonly railCollapsed: boolean;
  readonly railMaximized: boolean;
  readonly drawer: "side" | "rail" | null;
  readonly setSideWidth: (w: number) => void;
  readonly setRailWidth: (w: number) => void;
  readonly resetSideWidth: () => void;
  readonly resetRailWidth: () => void;
  readonly toggleSide: () => void;
  readonly toggleRail: () => void;
  readonly openRail: () => void;
  readonly toggleRailMaximize: () => void;
  readonly closeDrawer: () => void;
};

const SIDE_DEFAULT = 264;
const SIDE_MIN = 200;
const SIDE_MAX = 400;
const RAIL_LIST_DEFAULT = 440;
const RAIL_WORKER_DEFAULT = 540;
const RAIL_MIN = 320;
const RAIL_MAX = 820;

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

export function clampSide(w: number): number {
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(w)));
}

export function clampRail(w: number): number {
  const maxByViewport =
    typeof window !== "undefined" ? Math.max(RAIL_MIN, window.innerWidth - 460) : RAIL_MAX;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, maxByViewport, Math.round(w)));
}

export function useShellLayout(workerActive: boolean): ShellLayoutState {
  const [sideWidth, setSideWidthState] = useState(() =>
    clampSide(readNum("eevee.sideW", SIDE_DEFAULT)),
  );
  const [listRailW, setListRailW] = useState(() =>
    clampRail(readNum("eevee.railW", RAIL_LIST_DEFAULT)),
  );
  const [workerRailW, setWorkerRailW] = useState(() =>
    clampRail(readNum("eevee.workerRailW", RAIL_WORKER_DEFAULT)),
  );
  const [sideCollapsed, setSideCollapsed] = useState(() => readBool("eevee.sideCollapsed", false));
  const [railCollapsed, setRailCollapsed] = useState(() => readBool("eevee.railCollapsed", false));
  const [railMaximized, setRailMaximized] = useState(false);
  const [drawer, setDrawer] = useState<"side" | "rail" | null>(null);

  useEffect(() => {
    if (!workerActive) setRailMaximized(false);
  }, [workerActive]);

  const railWidth = workerActive ? workerRailW : listRailW;

  const setSideWidth = useCallback((w: number) => {
    const clamped = clampSide(w);
    setSideWidthState(clamped);
    writePref("eevee.sideW", String(clamped));
  }, []);

  const setRailWidth = useCallback(
    (w: number) => {
      const clamped = clampRail(w);
      if (workerActive) {
        setWorkerRailW(clamped);
        writePref("eevee.workerRailW", String(clamped));
      } else {
        setListRailW(clamped);
        writePref("eevee.railW", String(clamped));
      }
    },
    [workerActive],
  );

  const resetSideWidth = useCallback(() => setSideWidth(SIDE_DEFAULT), [setSideWidth]);
  const resetRailWidth = useCallback(
    () => setRailWidth(workerActive ? RAIL_WORKER_DEFAULT : RAIL_LIST_DEFAULT),
    [setRailWidth, workerActive],
  );

  const toggleSide = useCallback(() => {
    if (window.innerWidth <= 760) {
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
    if (window.innerWidth <= 1200) {
      setDrawer((prev) => (prev === "rail" ? null : "rail"));
      return;
    }
    setRailMaximized(false);
    setRailCollapsed((prev) => {
      const next = !prev;
      writePref("eevee.railCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const openRail = useCallback(() => {
    if (window.innerWidth <= 1200) {
      setDrawer("rail");
      return;
    }
    setRailCollapsed(false);
    writePref("eevee.railCollapsed", "0");
  }, []);

  const toggleRailMaximize = useCallback(() => {
    setRailMaximized((prev) => !prev);
  }, []);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  return {
    sideWidth,
    railWidth,
    sideCollapsed,
    railCollapsed,
    railMaximized,
    drawer,
    setSideWidth,
    setRailWidth,
    resetSideWidth,
    resetRailWidth,
    toggleSide,
    toggleRail,
    openRail,
    toggleRailMaximize,
    closeDrawer,
  };
}
