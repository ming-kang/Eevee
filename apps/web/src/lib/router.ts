import type { ProjectId, WorkerId } from "@eevee/protocol";

export type ProjectSubView = "chat" | "memory" | "usage";
export type SettingsSection = "providers" | "models" | "mcp" | "skills" | "config";

export type Route =
  | { readonly name: "overview" }
  | {
      readonly name: "project";
      readonly pid: ProjectId;
      readonly view: ProjectSubView;
      readonly workerId?: WorkerId;
    }
  | { readonly name: "control"; readonly section: SettingsSection };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  if (raw === "" || raw === "overview") return { name: "overview" };
  const parts = raw
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  if (parts[0] === "control") {
    const sec = parts[1];
    const section: SettingsSection =
      sec === "models" || sec === "mcp" || sec === "skills" || sec === "config" ? sec : "providers";
    return { name: "control", section };
  }
  if (parts[0] === "p" && parts[1]) {
    const pid = parts[1] as ProjectId;
    if (parts[2] === "memory") return { name: "project", pid, view: "memory" };
    if (parts[2] === "usage") return { name: "project", pid, view: "usage" };
    if (parts[2] === "w" && parts[3]) {
      return { name: "project", pid, view: "chat", workerId: parts[3] as WorkerId };
    }
    return { name: "project", pid, view: "chat" };
  }
  return { name: "overview" };
}

export function formatRoute(route: Route): string {
  if (route.name === "overview") return "#/overview";
  if (route.name === "control") return `#/control/${route.section}`;
  const pid = encodeURIComponent(route.pid);
  if (route.view === "memory") return `#/p/${pid}/memory`;
  if (route.view === "usage") return `#/p/${pid}/usage`;
  if (route.workerId) return `#/p/${pid}/w/${encodeURIComponent(route.workerId)}`;
  return `#/p/${pid}`;
}

export function navigate(route: Route): void {
  const target = formatRoute(route);
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}
