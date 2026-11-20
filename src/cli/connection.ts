import { isAlive, type RuntimeRecord, readRuntimeRecord } from "../daemon/instance.ts";
import { type Client, createClient } from "../protocol/client.ts";
import { readText } from "../shared/fs.ts";
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
  if (record === undefined || !isAlive(record.pid)) return undefined;
  const token = (await readText(paths.runtime.token))?.trim();
  const baseUrl = `http://127.0.0.1:${record.port}`;
  const client = createClient({ baseUrl, ...(token ? { token } : {}) });
  try {
    await client.call("GET /api/health");
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
