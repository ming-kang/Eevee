import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const WEB_SESSION_COOKIE = "eevee_session";
export const WEB_TICKET_TTL_MS = 10 * 60_000;
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const MAX_PENDING_TICKETS = 64;
const MAX_ACTIVE_SESSIONS = 128;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) cookies.set(name, value);
  }
  return cookies;
}

export function isSameOriginRequest(req: IncomingMessage, port: number): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string") {
    const normalized = fetchSite.trim().toLowerCase();
    if (normalized === "cross-site") return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim().length > 0) {
    const normalized = origin.trim().toLowerCase();
    return normalized === `http://127.0.0.1:${port}` || normalized === `http://localhost:${port}`;
  }
  return true;
}

export class WebAuthManager {
  readonly #tickets = new Map<string, number>();
  readonly #sessions = new Map<string, number>();

  issueTicket(now = Date.now()): { readonly ticket: string; readonly expiresAt: number } {
    this.#prune(this.#tickets, now, MAX_PENDING_TICKETS - 1);
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = now + WEB_TICKET_TTL_MS;
    this.#tickets.set(sha256Hex(ticket), expiresAt);
    return { ticket, expiresAt };
  }

  redeemTicket(ticket: string, now = Date.now()): boolean {
    if (ticket.length === 0) return false;
    const digest = sha256Hex(ticket);
    const expiresAt = this.#tickets.get(digest);
    if (expiresAt === undefined) return false;
    this.#tickets.delete(digest);
    return expiresAt > now;
  }

  createSession(now = Date.now()): { readonly sessionId: string; readonly cookieHeader: string } {
    this.#prune(this.#sessions, now, MAX_ACTIVE_SESSIONS - 1);
    const sessionId = randomBytes(32).toString("hex");
    this.#sessions.set(sha256Hex(sessionId), now + WEB_SESSION_TTL_MS);
    const maxAge = Math.floor(WEB_SESSION_TTL_MS / 1000);
    return {
      sessionId,
      cookieHeader: `${WEB_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    };
  }

  verifyCookieHeader(cookieHeader: string | undefined, now = Date.now()): string | undefined {
    const sessionId = parseCookies(cookieHeader).get(WEB_SESSION_COOKIE);
    if (!sessionId) return undefined;
    const digest = sha256Hex(sessionId);
    const expiresAt = this.#sessions.get(digest);
    if (expiresAt === undefined) return undefined;
    if (expiresAt <= now) {
      this.#sessions.delete(digest);
      return undefined;
    }
    this.#sessions.set(digest, now + WEB_SESSION_TTL_MS);
    return sessionId;
  }

  revokeCookieHeader(cookieHeader: string | undefined): void {
    const sessionId = parseCookies(cookieHeader).get(WEB_SESSION_COOKIE);
    if (!sessionId) return;
    this.#sessions.delete(sha256Hex(sessionId));
  }

  clearCookieHeader(): string {
    return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  #prune(store: Map<string, number>, now: number, maxRetained: number): void {
    for (const [key, expiresAt] of store) {
      if (expiresAt <= now) store.delete(key);
    }
    while (store.size > maxRetained) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
}
