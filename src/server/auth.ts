import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const CODE_TTL_MS = 90_000;

export type AuthOptions = {
  token?: string;
  now?: () => number;
};

/**
 * One token guards the local interface: the CLI reads it from its file, and the browser receives it by trading a
 * one-time code, so the token itself never travels in a URL.
 */
export class Auth {
  readonly token: string;
  readonly #codes = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: AuthOptions = {}) {
    this.token = options.token ?? randomToken();
    this.#now = options.now ?? Date.now;
  }

  verify(presented: string | undefined): boolean {
    return presented !== undefined && safeEqual(presented, this.token);
  }

  issueCode(): string {
    const code = randomToken();
    this.#codes.set(code, this.#now() + CODE_TTL_MS);
    return code;
  }

  /** The token for a code that is unused and not expired; every code works at most once. */
  exchange(code: string): string | undefined {
    const expires = this.#codes.get(code);
    this.#codes.delete(code);
    if (expires === undefined || this.#now() > expires) return undefined;
    return this.token;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackRequest(request: Pick<IncomingMessage, "headers">): boolean {
  const host = request.headers.host;
  if (!host || !LOOPBACK_HOSTS.has(hostname(host))) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOSTS.has(hostname(new URL(origin).host));
  } catch {
    return false;
  }
}

function hostname(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

const randomToken = () => randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
