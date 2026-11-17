import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { readJson, readText, writeFileAtomic, writeJsonAtomic } from "../shared/fs.ts";

export const CODE_TTL_MS = 90_000;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

export type Caller = "cli" | "browser";

type StoredSession = { hash: string; lastSeen: number };

export type AuthOptions = {
  cliTokenPath: string;
  sessionsPath: string;
  now?: () => number;
};

export class Auth {
  readonly #cliToken: string;
  readonly #sessionsPath: string;
  readonly #sessions: Map<string, number>;
  readonly #codes = new Map<string, number>();
  readonly #now: () => number;

  private constructor(cliToken: string, sessions: StoredSession[], options: AuthOptions) {
    this.#cliToken = cliToken;
    this.#sessionsPath = options.sessionsPath;
    this.#now = options.now ?? Date.now;
    this.#sessions = new Map(sessions.map((s) => [s.hash, s.lastSeen]));
  }

  static async open(options: AuthOptions): Promise<Auth> {
    let cliToken = (await readText(options.cliTokenPath))?.trim();
    if (!cliToken) {
      cliToken = token();
      await writeFileAtomic(options.cliTokenPath, cliToken, { mode: 0o600 });
    }
    const sessions = (await readJson<StoredSession[]>(options.sessionsPath)) ?? [];
    return new Auth(cliToken, sessions, options);
  }

  verify(presented: string | undefined): Caller | undefined {
    if (!presented) return undefined;
    if (safeEqual(presented, this.#cliToken)) return "cli";
    const hash = sha256(presented);
    const lastSeen = this.#sessions.get(hash);
    if (lastSeen === undefined) return undefined;
    if (this.#now() - lastSeen > SESSION_IDLE_MS) {
      this.#sessions.delete(hash);
      return undefined;
    }
    this.#sessions.set(hash, this.#now());
    return "browser";
  }

  issueCode(): string {
    const code = token();
    this.#codes.set(code, this.#now() + CODE_TTL_MS);
    return code;
  }

  async exchange(code: string): Promise<string | undefined> {
    const expires = this.#codes.get(code);
    this.#codes.delete(code);
    if (expires === undefined || this.#now() > expires) return undefined;
    const session = token();
    this.#sessions.set(sha256(session), this.#now());
    await this.#save();
    return session;
  }

  async #save(): Promise<void> {
    const now = this.#now();
    const live = [...this.#sessions]
      .filter(([, lastSeen]) => now - lastSeen <= SESSION_IDLE_MS)
      .map(([hash, lastSeen]) => ({ hash, lastSeen }));
    await writeJsonAtomic(this.#sessionsPath, live, { mode: 0o600 });
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

const token = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
