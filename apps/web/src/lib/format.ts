import type { BackgroundTaskStatus } from "@eevee/protocol";

export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

export function formatClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s 前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m 前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h 前`;
  return `${Math.floor(diffHr / 24)}d 前`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

export function workerStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "queued":
      return "排队中";
    case "idle":
      return "空闲";
    case "closed":
      return "已关闭";
    default:
      return status;
  }
}

export function workerStatusTone(status: string): "info" | "positive" | "warning" | "neutral" {
  switch (status) {
    case "running":
      return "info";
    case "idle":
      return "positive";
    case "queued":
      return "warning";
    default:
      return "neutral";
  }
}

export function isTaskActive(status: BackgroundTaskStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

export function taskStatusPhase(status: BackgroundTaskStatus): number {
  if (status === "queued") return 0;
  if (status === "running") return 1;
  if (status === "stopping") return 2;
  return 3;
}

export function taskStatusStage(status: BackgroundTaskStatus): "working" | "done" | "blocked" {
  if (isTaskActive(status)) return "working";
  if (status === "completed") return "done";
  return "blocked";
}

export function taskStatusLabel(status: BackgroundTaskStatus, exitCode?: number): string {
  switch (status) {
    case "completed":
      return exitCode !== undefined && exitCode !== 0 ? `completed (${exitCode})` : "completed";
    case "failed":
      return exitCode !== undefined ? `failed (${exitCode})` : "failed";
    case "queued":
    case "running":
    case "stopping":
    case "timed_out":
    case "cancelled":
    case "interrupted":
      return status;
  }
}

export function taskStatusTone(
  status: BackgroundTaskStatus,
): "info" | "positive" | "warning" | "negative" | "neutral" {
  switch (status) {
    case "queued":
    case "running":
      return "info";
    case "stopping":
    case "cancelled":
      return "warning";
    case "completed":
      return "positive";
    case "failed":
    case "timed_out":
    case "interrupted":
      return "negative";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
