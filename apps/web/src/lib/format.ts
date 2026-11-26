export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatRelativeTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
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
