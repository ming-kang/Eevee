import type { ModelAuth } from "@earendil-works/pi-ai";

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

export function extractAuthSecrets(auth: ModelAuth | undefined): string[] {
  if (!auth) return [];
  return [
    auth.apiKey,
    ...Object.values(auth.headers ?? {}).filter((value) => typeof value === "string"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function redactSecrets(
  message: string,
  secrets: readonly string[],
  maxLength?: number,
): string {
  let sanitized = stripAnsi(message);
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return maxLength === undefined ? sanitized : sanitized.slice(0, maxLength);
}

export async function withAbortTimeout<T>(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  fn: (context: { readonly signal: AbortSignal; readonly timedOut: () => boolean }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    onAbort();
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  timer.unref?.();
  try {
    return await fn({ signal: controller.signal, timedOut: () => expired });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}
