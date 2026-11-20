import type { ShallowRef } from "vue";
import { watch } from "vue";
import type { BoardView, ProjectSummary } from "../../../src/api/contract.ts";
import { boardEvents } from "../lib/notify.ts";
import type { Route } from "../lib/router.ts";
import type { BoardState } from "./engine-data.ts";

export const NOTIFY_KEY = "eevee.notify";

export function notifySupported(): boolean {
  return typeof Notification !== "undefined";
}

export function notifyEnabled(): boolean {
  return localStorage.getItem(NOTIFY_KEY) === "on";
}

export function setNotifyEnabled(on: boolean): void {
  if (on) localStorage.setItem(NOTIFY_KEY, "on");
  else localStorage.removeItem(NOTIFY_KEY);
}

/** The board the user can already see needs no desktop card; everything else does. */
function shouldFire(enabled: boolean, onProject: boolean): boolean {
  if (!enabled || !notifySupported() || Notification.permission !== "granted") return false;
  return document.hidden || !onProject;
}

/**
 * Watches every project's board and raises a desktop notification per event. Enabled by the
 * `eevee.notify` switch in Settings and the browser's permission, both read per event so the
 * switch takes effect without a reload.
 */
export function useNotifications(input: {
  boards: ShallowRef<Record<string, BoardState | undefined>>;
  projects: () => readonly ProjectSummary[];
  route: () => Route;
  open: (route: Route) => void;
}): void {
  const previous = new Map<string, BoardView>();

  watch(
    input.boards,
    (next) => {
      for (const pid of [...previous.keys()]) {
        if (next[pid] === undefined) previous.delete(pid);
      }
      for (const [pid, state] of Object.entries(next)) {
        const board = state?.board;
        if (!board) continue;
        const prev = previous.get(pid);
        previous.set(pid, board);
        if (prev === undefined) continue;
        const project = input.projects().find((p) => p.id === pid);
        if (!project) continue;
        const route = input.route();
        const onProject = "pid" in route && route.pid === pid;
        for (const event of boardEvents(prev, board, project)) {
          if (!shouldFire(notifyEnabled(), onProject)) continue;
          const notification = new Notification(event.title, {
            body: event.body,
            tag: event.tag,
          });
          notification.onclick = () => {
            window.focus();
            input.open(event.route);
            notification.close();
          };
        }
      }
    },
    { immediate: true },
  );
}
