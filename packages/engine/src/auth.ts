import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode, isEnoent } from "@eevee/agent";
import { EeveeClient } from "@eevee/protocol";
import { dataDirLayout, resolveDataDir } from "./data-dir.ts";
import { readPidStateFile, removePidStateFile, writePidStateFile } from "./state-file.ts";

export type EngineRuntimeState = {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly protocolVersion: number;
  readonly engineVersion: string;
  readonly startedAt: number;
};

export type LocalEngineConnection = {
  readonly url: string;
  readonly token: string;
  readonly client: EeveeClient;
};

function isEexist(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

export async function readAuthToken(tokenFile: string): Promise<string | undefined> {
  try {
    const raw = await readFile(tokenFile, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function ensureAuthToken(tokenFile: string): Promise<string> {
  await mkdir(dirname(tokenFile), { recursive: true });
  const existing = await readAuthToken(tokenFile);
  if (existing !== undefined) {
    await chmod(tokenFile, 0o600).catch(() => undefined);
    return existing;
  }

  const generated = randomBytes(32).toString("hex");
  try {
    await writeFile(tokenFile, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tokenFile, 0o600).catch(() => undefined);
    return generated;
  } catch (error) {
    if (isEexist(error)) {
      const raced = await readAuthToken(tokenFile);
      if (raced !== undefined) return raced;
      await writeFile(tokenFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(tokenFile, 0o600).catch(() => undefined);
      return generated;
    }
    throw error;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyBearerToken(header: string | undefined, expected: string): boolean {
  if (!header || expected.length === 0) return false;
  const space = header.indexOf(" ");
  if (space <= 0) return false;
  const scheme = header.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return false;
  const token = header.slice(space + 1).trim();
  if (token.length === 0) return false;

  const sameDigest = timingSafeEqual(sha256(token), sha256(expected));
  return sameDigest && token.length === expected.length;
}

export function writeEngineState(stateFile: string, state: EngineRuntimeState): Promise<void> {
  return writePidStateFile(stateFile, state);
}

function isEngineRuntimeState(value: unknown): value is EngineRuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.host === "string" &&
    candidate.host.length > 0 &&
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    candidate.port > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    typeof candidate.protocolVersion === "number" &&
    typeof candidate.engineVersion === "string" &&
    typeof candidate.startedAt === "number"
  );
}

export function readEngineState(stateFile: string): Promise<EngineRuntimeState | undefined> {
  return readPidStateFile(stateFile, isEngineRuntimeState);
}

export function removeEngineState(stateFile: string, expectedPid?: number): Promise<void> {
  return removePidStateFile(stateFile, isEngineRuntimeState, expectedPid);
}

export async function connectLocalEngine(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalEngineConnection> {
  const layout = dataDirLayout(resolveDataDir(env));
  const envUrl = env.EEVEE_URL?.trim();
  let url = envUrl && envUrl.length > 0 ? envUrl : undefined;

  if (url === undefined) {
    const state = await readEngineState(layout.stateFile);
    if (state === undefined) {
      throw new Error(
        `Eevee engine is not running (missing state file at ${layout.stateFile}). Start it with "eevee start".`,
      );
    }
    url = state.url;
  }

  const envToken = env.EEVEE_TOKEN;
  const token = envToken !== undefined ? envToken.trim() : await readAuthToken(layout.tokenFile);
  if (token === undefined || token.length === 0) {
    throw new Error(`Missing Eevee auth token (checked EEVEE_TOKEN and ${layout.tokenFile}).`);
  }

  return {
    url,
    token,
    client: new EeveeClient({ baseUrl: url, token }),
  };
}
