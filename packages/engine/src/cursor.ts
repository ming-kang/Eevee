import type { Cursor, ScanOrder } from "@earendil-works/pi-durable";
import { EngineError } from "./engine-error.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isScanOrder(value: unknown): value is ScanOrder {
  return value === "ascending" || value === "descending";
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    const keys = Object.keys(parsed);
    if (keys.some((key) => key !== "after" && key !== "order")) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    const { after, order } = parsed;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    if (order !== undefined && !isScanOrder(order)) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    return order === undefined ? { after } : { after, order };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
}
