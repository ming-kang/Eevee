import {
  isAlive,
  type RuntimeRecord,
  readRuntimeRecord,
  removeRuntimeRecord,
} from "../daemon/instance.ts";
import { type Client, createClient } from "../protocol/client.ts";
import type { EeveePaths } from "../shared/paths.ts";

export type Connection = {
  record: RuntimeRecord;
  baseUrl: string;
  client: Client;
};

export class NotRunning extends Error {
  override name = "NotRunning";
  constructor() {
    super("The Engine is not running. Run eevee to start it and open the panel.");
  }
}

export async function findEngine(paths: EeveePaths): Promise<Connection | undefined> {
  const record = await readRuntimeRecord(paths.runtime.record);
  if (record === undefined) return undefined;
  if (!isAlive(record.pid)) {
    await removeRuntimeRecord(paths.runtime.record, record);
    return undefined;
  }
  const baseUrl = `http://127.0.0.1:${record.port}`;
  const client = createClient({ baseUrl, token: record.token });
  try {
    const health = await createClient({
      baseUrl,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(1000) }),
    }).call("GET /api/health");
    if (health.bootId !== record.bootId) {
      await removeRuntimeRecord(paths.runtime.record, record);
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { record, baseUrl, client };
}

export async function connect(paths: EeveePaths): Promise<Connection> {
  const connection = await findEngine(paths);
  if (connection === undefined) throw new NotRunning();
  return connection;
}
