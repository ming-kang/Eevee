import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { utf8HeadClip } from "../../shared/truncate.ts";

export const DEFAULT_MCP_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MCP_RING_LINES = 100;
export const DEFAULT_MCP_RING_BYTES = 32 * 1024;

export type McpServerLogOptions = {
  readonly logPath?: string;
  readonly maxFileBytes?: number;
  readonly maxLinesPerServer?: number;
  readonly maxBytesPerServer?: number;
};

type ServerRing = {
  readonly lines: string[];
  bytes: number;
  partialStderr: string;
};

function formatNotificationMessage(params: unknown): {
  readonly level: string;
  readonly message: string;
} {
  if (typeof params !== "object" || params === null) {
    return { level: "info", message: String(params ?? "") };
  }
  const record = params as Record<string, unknown>;
  const level = typeof record.level === "string" && record.level !== "" ? record.level : "info";
  const logger =
    typeof record.logger === "string" && record.logger !== "" ? `${record.logger}: ` : "";
  let body: string;
  if (typeof record.data === "string") {
    body = record.data;
  } else if (record.data === undefined) {
    body = "";
  } else {
    try {
      body = JSON.stringify(record.data);
    } catch {
      body = String(record.data);
    }
  }
  return { level, message: `${logger}${body}` };
}

export class McpServerLog {
  private readonly logPath?: string;
  private readonly maxFileBytes: number;
  private readonly maxLinesPerServer: number;
  private readonly maxBytesPerServer: number;
  private readonly rings = new Map<string, ServerRing>();
  private writeChain: Promise<void> = Promise.resolve();
  private currentBytes?: number;
  private dirPrepared = false;
  private closed = false;

  constructor(options: McpServerLogOptions = {}) {
    this.logPath = options.logPath;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MCP_LOG_MAX_FILE_BYTES;
    this.maxLinesPerServer = options.maxLinesPerServer ?? DEFAULT_MCP_RING_LINES;
    this.maxBytesPerServer = options.maxBytesPerServer ?? DEFAULT_MCP_RING_BYTES;
  }

  recordStderr(server: string, chunk: string): void {
    if (chunk === "") return;
    const ring = this.ensureRing(server);
    ring.partialStderr += chunk;
    const parts = ring.partialStderr.split(/\r?\n/);
    ring.partialStderr = parts.pop() ?? "";
    for (const part of parts) {
      if (part === "") continue;
      this.appendEntry(server, "stderr", part);
    }
  }

  flushStderr(server: string): void {
    const ring = this.rings.get(server);
    if (ring === undefined || ring.partialStderr === "") return;
    const trailing = ring.partialStderr.replace(/\r$/, "");
    ring.partialStderr = "";
    if (trailing !== "") {
      this.appendEntry(server, "stderr", trailing);
    }
  }

  recordNotification(server: string, params: unknown): void {
    const { level, message } = formatNotificationMessage(params);
    if (message === "") return;
    for (const line of message.split(/\r?\n/)) {
      if (line === "") continue;
      this.appendEntry(server, `mcp:${level}`, line);
    }
  }

  recordDiagnostic(server: string, level: string, message: string): void {
    if (message === "") return;
    for (const line of message.split(/\r?\n/)) {
      if (line === "") continue;
      this.appendEntry(server, level, line);
    }
  }

  getServerLogs(server: string): readonly string[] {
    const ring = this.rings.get(server);
    if (ring === undefined) return [];
    return [...ring.lines];
  }

  clearServerLogs(server: string): void {
    this.rings.delete(server);
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const server of this.rings.keys()) {
      this.flushStderr(server);
    }
    await this.writeChain;
  }

  private ensureRing(server: string): ServerRing {
    let ring = this.rings.get(server);
    if (ring === undefined) {
      ring = { lines: [], bytes: 0, partialStderr: "" };
      this.rings.set(server, ring);
    }
    return ring;
  }

  private appendEntry(server: string, tag: string, message: string): void {
    const timestamp = new Date().toISOString();
    const ringLine = utf8HeadClip(`${timestamp} [${tag}] ${message}`, this.maxBytesPerServer);
    const ring = this.ensureRing(server);
    const lineBytes = Buffer.byteLength(ringLine, "utf8");
    ring.lines.push(ringLine);
    ring.bytes += lineBytes;
    while (
      ring.lines.length > this.maxLinesPerServer ||
      (ring.lines.length > 1 && ring.bytes > this.maxBytesPerServer)
    ) {
      const removed = ring.lines.shift();
      if (removed !== undefined) {
        ring.bytes -= Buffer.byteLength(removed, "utf8");
      }
    }

    if (this.logPath !== undefined && !this.closed) {
      const fileLine = `${timestamp} [${server}] [${tag}] ${message}\n`;
      this.enqueueWrite(fileLine);
    }
  }

  private enqueueWrite(line: string): void {
    const logPath = this.logPath;
    if (logPath === undefined) return;
    this.writeChain = this.writeChain
      .then(() => this.writeLine(logPath, line))
      .catch(() => undefined);
  }

  private async writeLine(logPath: string, line: string): Promise<void> {
    if (!this.dirPrepared) {
      await mkdir(dirname(logPath), { recursive: true });
      this.dirPrepared = true;
    }
    if (this.currentBytes === undefined) {
      try {
        this.currentBytes = (await stat(logPath)).size;
      } catch {
        this.currentBytes = 0;
      }
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.currentBytes > 0 && this.currentBytes + lineBytes > this.maxFileBytes) {
      const rotated = `${logPath}.1`;
      await rm(rotated, { force: true }).catch(() => undefined);
      await rename(logPath, rotated).catch(() => undefined);
      this.currentBytes = 0;
    }
    await appendFile(logPath, line, "utf8");
    this.currentBytes += lineBytes;
  }
}
