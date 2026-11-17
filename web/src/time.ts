export function formatRelativeTime(
  ms: number,
  nowMs = Date.now(),
  style: "long" | "short" = "long",
): string {
  const diff = Math.max(0, nowMs - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return style === "short" ? `${mins}分` : `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return style === "short" ? `${hours}时` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return style === "short" ? `${days}天` : `${days} 天前`;
  const weeks = Math.floor(days / 7);
  return style === "short" ? `${weeks}周` : `${weeks} 周前`;
}

export function formatClockTime(ms: number, nowMs = Date.now()): string {
  const date = new Date(ms);
  const now = new Date(nowMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m${s}s`;
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
