import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type MemoryChange,
  type MemoryChangeDetail,
  type MemorySource,
  ProblemError,
  type TicketId,
} from "../../domain/index.ts";
import { isNotFound, readText, writeFileAtomic } from "../../shared/fs.ts";
import { resolveInside } from "../../shared/paths.ts";
import { type GitChange, GitStore } from "./git.ts";

export type MemoryOp = (
  | { action: "create"; file: string; content: string }
  | { action: "edit"; file: string; oldText: string; newText: string }
  | { action: "write"; file: string; content: string }
  | { action: "delete"; file: string }
  | { action: "rename"; from: string; to: string }
) & { version?: string };

export function memoryVersion(content: string | undefined): string {
  return content === undefined ? "" : createHash("sha256").update(content).digest("hex");
}
export type MemoryFileInfo = { path: string; size: number };
export type MemoryPolicy = "project" | "global";

export class MemoryConflict extends Error {
  override name = "MemoryConflict";
  readonly file: string;
  readonly current: string;

  constructor(file: string, message: string, current: string) {
    super(message);
    this.file = file;
    this.current = current;
  }
}

type Version = GitChange & { id: number };
type Prepared = { before: Map<string, string | undefined>; after: Map<string, string | undefined> };
const queues = new Map<string, Promise<unknown>>();

export class MemoryStore {
  readonly dir: string;
  readonly #policy: MemoryPolicy;
  readonly #git: GitStore;

  constructor(dir: string, policy: MemoryPolicy = "project") {
    this.dir = resolve(dir);
    this.#policy = policy;
    this.#git = new GitStore(this.dir);
  }

  ensure(initial: string): Promise<void> {
    return this.#serial(async () => {
      await mkdir(this.dir, { recursive: true });
      if (await this.#git.isRepo()) {
        if ((await this.#git.log()).length > 0) return;
      } else await this.#git.init();
      if ((await this.#read("MEMORY.md")) === undefined)
        await writeFileAtomic(join(this.dir, "MEMORY.md"), initial);
      await this.#git.commit(["MEMORY.md"], {
        subject: "init",
        trailers: this.#trailers(1, { kind: "system" }),
      });
    });
  }

  read(file: string): Promise<string | undefined> {
    return this.#serial(() => this.#read(file));
  }

  file(file: string): Promise<{ path: string; content: string; version: string }> {
    return this.#serial(async () => {
      const content = await this.#read(file);
      if (content === undefined) throw new ProblemError({ code: "no_memory_file", file });
      return { path: await this.#path(file), content, version: memoryVersion(content) };
    });
  }

  async #read(file: string): Promise<string | undefined> {
    try {
      const path = await this.#path(file);
      return await readText(join(this.dir, path));
    } catch (error) {
      if (error instanceof MemoryConflict) throw new ProblemError({ code: "no_memory_file", file });
      throw error;
    }
  }

  files(): Promise<MemoryFileInfo[]> {
    return this.#serial(async () => {
      const files: MemoryFileInfo[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name.toLowerCase() === ".git" || entry.isSymbolicLink()) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (this.#policy === "project") await walk(full);
          } else if (entry.isFile()) {
            const path = relative(this.dir, full).replaceAll("\\", "/");
            if (this.#policy === "global" && path !== "MEMORY.md") continue;
            const info = await stat(full);
            files.push({ path, size: info.size });
          }
        }
      };
      await walk(this.dir);
      return files.sort((a, b) =>
        a.path === "MEMORY.md" ? -1 : b.path === "MEMORY.md" ? 1 : a.path.localeCompare(b.path),
      );
    });
  }

  history(limit = 20): Promise<MemoryChange[]> {
    return this.#serial(async () => {
      const versions = await this.#versions();
      return Promise.all(
        (limit > 0 ? versions.slice(-limit).reverse() : []).map((version) => this.#change(version)),
      );
    });
  }

  show(id: number): Promise<MemoryChangeDetail> {
    return this.#serial(async () => {
      const version = await this.#find(id);
      return { ...(await this.#change(version)), files: await this.#git.diff(version.hash) };
    });
  }

  validate(ops: readonly MemoryOp[]): Promise<void> {
    return this.#serial(async () => {
      await this.#prepare(ops);
    });
  }

  apply(
    ops: readonly MemoryOp[],
    source: MemorySource,
    summary?: string,
  ): Promise<MemoryChange | undefined> {
    return this.#serial(async () => {
      if (ops.length === 0) return undefined;
      const prepared = await this.#prepare(ops);
      await this.#captureUserEdits();
      const changed = [...prepared.after.keys()].filter(
        (file) => prepared.after.get(file) !== prepared.before.get(file),
      );
      if (changed.length === 0) return undefined;
      try {
        await this.#write(prepared.after, changed);
      } catch (error) {
        await this.#write(prepared.before, changed);
        throw error;
      }
      const subject =
        summary ??
        [...changed]
          .sort()
          .map(
            (file) =>
              `${prepared.before.get(file) === undefined ? "create" : prepared.after.get(file) === undefined ? "delete" : "edit"} ${file}`,
          )
          .join("; ");
      return this.#save(changed, source, subject);
    });
  }

  undo(id: number, source: MemorySource): Promise<MemoryChange> {
    return this.#serial(async () => {
      const version = await this.#find(id);
      if (id === 1) throw new ProblemError({ code: "undo_failed", change: id });
      const files = await this.#git.fileChanges(version.hash);
      for (const file of files) await this.#path(file.path);
      await this.#captureUserEdits();
      if ("conflict" in (await this.#git.revert(version.hash)))
        throw new ProblemError({ code: "undo_failed", change: id });
      return this.#save(
        files.map((file) => file.path),
        source,
        `Undo change #${id}`,
      );
    });
  }

  captureUserEdits(): Promise<MemoryChange | undefined> {
    return this.#serial(() => this.#captureUserEdits());
  }

  async #captureUserEdits(): Promise<MemoryChange | undefined> {
    const changed = [];
    for (const file of await this.#git.changedFiles()) {
      if (this.#policy === "global" && file.path !== "MEMORY.md") continue;
      await this.#path(file.path);
      changed.push(file);
    }
    if (changed.length === 0) return undefined;
    return this.#save(
      changed.map((file) => file.path),
      { kind: "user" },
      changed
        .map(
          (file) =>
            `${file.status === "added" ? "create" : file.status === "deleted" ? "delete" : "edit"} ${file.path}`,
        )
        .join("; "),
    );
  }

  async #prepare(ops: readonly MemoryOp[]): Promise<Prepared> {
    const before = new Map<string, string | undefined>();
    const after = new Map<string, string | undefined>();
    const get = async (file: string) => {
      const path = await this.#path(file, true);
      for (const [other, content] of after) {
        if (content !== undefined && (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)))
          throw new MemoryConflict(file, `A file conflicts with a directory in ${file}.`, "");
      }
      if (!before.has(path)) {
        const value = await readText(join(this.dir, path));
        before.set(path, value);
        after.set(path, value);
      }
      return { path, current: after.get(path) };
    };
    for (const op of ops) {
      if (
        this.#policy === "global" &&
        (op.action === "create" || op.action === "delete" || op.action === "rename")
      )
        throw new ProblemError({ code: "memory_restricted" });
      if (op.action === "rename") {
        const from = await get(op.from);
        this.#checkVersion(op.from, from.current, op.version);
        const to = await get(op.to);
        if (from.current === undefined)
          throw new MemoryConflict(op.from, `${op.from} does not exist.`, "");
        if (from.path === to.path) throw new ProblemError({ code: "invalid", field: "to" });
        if (to.current !== undefined)
          throw new MemoryConflict(op.to, `${op.to} already exists.`, to.current);
        after.set(from.path, undefined);
        after.set(to.path, from.current);
        continue;
      }
      const { path, current } = await get(op.file);
      this.#checkVersion(op.file, current, op.version);
      if (this.#policy === "global" && current === undefined)
        throw new ProblemError({ code: "memory_restricted" });
      if (op.action === "create" && current !== undefined)
        throw new MemoryConflict(
          op.file,
          `${op.file} already exists; use edit to change it.`,
          current,
        );
      if ((op.action === "edit" || op.action === "delete") && current === undefined)
        throw new MemoryConflict(
          op.file,
          `${op.file} does not exist; use create to make a new one.`,
          "",
        );
      if (op.action === "edit") {
        const at = (current as string).indexOf(op.oldText);
        if (!op.oldText || at < 0 || (current as string).indexOf(op.oldText, at + 1) >= 0)
          throw new MemoryConflict(
            op.file,
            `No unique match for the original text in ${op.file}; retry against the latest content.`,
            current ?? "",
          );
        after.set(
          path,
          (current as string).slice(0, at) +
            op.newText +
            (current as string).slice(at + op.oldText.length),
        );
      } else {
        after.set(path, op.action === "delete" ? undefined : op.content);
      }
    }
    return { before, after };
  }

  #checkVersion(file: string, content: string | undefined, version: string | undefined): void {
    if (version !== undefined && memoryVersion(content) !== version)
      throw new ProblemError({ code: "memory_changed", file });
  }

  async #path(file: string, mutation = false): Promise<string> {
    const input = file.replaceAll("\\", "/");
    const fail = () =>
      new MemoryConflict(
        file,
        `The path must stay inside the memory store and outside .git: ${file}`,
        "",
      );
    if (
      !input ||
      input.includes("\0") ||
      input.includes(":") ||
      isAbsolute(input) ||
      input.split("/").some((part) => part.replace(/[ .]+$/g, "").toLowerCase() === ".git")
    )
      throw fail();
    let full: string;
    try {
      full = resolveInside(this.dir, input);
    } catch {
      throw fail();
    }
    const path = relative(this.dir, full).replaceAll("\\", "/");
    if (this.#policy === "global" && path !== "MEMORY.md") {
      if (mutation) throw new ProblemError({ code: "memory_restricted" });
      throw new MemoryConflict(file, "The global memory store has only one file, MEMORY.md.", "");
    }
    let parent = this.dir;
    for (const part of path.split("/")) {
      parent = join(parent, part);
      const info = await lstat(parent).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (info?.isSymbolicLink()) throw fail();
      if (info && (parent === full ? !info.isFile() : !info.isDirectory()))
        throw new MemoryConflict(file, `The path is not a regular memory file: ${file}`, "");
    }
    return path;
  }

  async #write(values: Map<string, string | undefined>, files: string[]): Promise<void> {
    for (const file of files) {
      const value = values.get(file);
      if (value === undefined) await rm(join(this.dir, file), { force: true });
      else await writeFileAtomic(join(this.dir, file), value);
    }
  }

  async #versions(): Promise<Version[]> {
    return (await this.#git.log()).flatMap((version, index) => {
      const id = Number(version.trailers["Eevee-Change"] ?? (index === 0 ? 1 : NaN));
      return Number.isSafeInteger(id) && id > 0 ? [{ ...version, id }] : [];
    });
  }

  async #find(id: number): Promise<Version> {
    const version = (await this.#versions()).find((version) => version.id === id);
    if (!version) throw new ProblemError({ code: "no_change", change: id });
    return version;
  }

  #trailers(id: number, source: MemorySource): Record<string, string> {
    return {
      "Eevee-Change": String(id),
      "Eevee-Source": source.kind,
      ...(source.ticketId === undefined ? {} : { "Eevee-Ticket": source.ticketId }),
    };
  }

  async #save(
    paths: readonly string[] | "all",
    source: MemorySource,
    subject: string,
  ): Promise<MemoryChange> {
    const versions = await this.#versions();
    const id = Math.max(0, ...versions.map((version) => version.id)) + 1;
    const hash = await this.#git.commit(paths, { subject, trailers: this.#trailers(id, source) });
    const version = (await this.#versions()).find((version) => version.hash === hash);
    if (!version) throw new Error("The saved memory change is missing");
    return this.#change(version);
  }

  async #change(version: Version): Promise<MemoryChange> {
    const kind = version.trailers["Eevee-Source"];
    const source: MemorySource = {
      kind: kind === "router" || kind === "dreaming" || kind === "user" ? kind : "system",
    };
    const ticket = version.trailers["Eevee-Ticket"];
    if (ticket && /^t\d+$/.test(ticket)) source.ticketId = ticket as TicketId;
    const files = (await this.#git.diff(version.hash)).map(
      ({ hunks: _hunks, binary: _binary, ...file }) => file,
    );
    return {
      id: version.id,
      at: version.at,
      source,
      summary:
        version.id === 1 && version.trailers["Eevee-Change"] === undefined
          ? "init"
          : version.subject,
      files,
    };
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const key = resolve(this.dir);
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next);
    const release = () => {
      if (queues.get(key) === next) queues.delete(key);
    };
    void next.then(release, release);
    return next;
  }
}
