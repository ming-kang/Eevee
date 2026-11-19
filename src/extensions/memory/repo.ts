import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  type MemoryChange,
  type MemoryChangeDetail,
  type MemoryFileChange,
  type MemorySource,
  ProblemError,
  type TicketId,
} from "../../contracts/index.ts";
import { isNotFound, readText, writeFileAtomic } from "../../shared/fs.ts";
import { resolveInside } from "../../shared/paths.ts";
import { parseDiff } from "./diff.ts";

const run = promisify(execFile);

export class MemoryConflict extends Error {
  override name = "MemoryConflict";
  readonly current: string;

  constructor(message: string, current: string) {
    super(message);
    this.current = current;
  }
}

export type MemoryFileInfo = { path: string; size: number };

const SOURCE_KINDS = new Set(["router", "dreaming", "user", "system"]);
const TICKET = /^t\d+$/;

type StatusEntry = { path: string; status: "added" | "modified" | "deleted" };

/** The trailer block a change's message carries so its source survives a rewrite of this code. */
function trailers(source: MemorySource): string {
  const lines = [`Eevee-Source: ${source.kind}`];
  if (source.ticketId !== undefined) lines.push(`Eevee-Ticket: ${source.ticketId}`);
  return lines.join("\n");
}

function verb(status: StatusEntry["status"]): string {
  return status === "added" ? "create" : status === "deleted" ? "delete" : "edit";
}

/** The metadata of one stored version, kept in the message as a subject plus trailers. */
type RawChange = { hash: string; at: string; subject: string; kind: string; ticket: string };

/** Strips the old "<label>[ tN]: " subject prefix of versions saved before source trailers existed. */
function legacySubject(subject: string): { kind: string; ticket?: string; summary: string } {
  if (subject === "memory: init") return { kind: "system", summary: "init" };
  if (subject === "user edit") return { kind: "user", summary: "user edit" };
  const labelled = /^(memory|dreaming)( t\d+)?: (.*)$/s.exec(subject);
  if (labelled) {
    return {
      kind: labelled[1] === "dreaming" ? "dreaming" : "router",
      ticket: labelled[2]?.trim(),
      summary: labelled[3] ?? "",
    };
  }
  const undone = /^Revert "(.*)"$/s.exec(subject);
  if (undone) {
    const inner = legacySubject(undone[1] ?? "");
    return { kind: "system", summary: `Undo ${inner.summary}` };
  }
  return { kind: "system", summary: subject };
}

function changeSource(raw: RawChange): { source: MemorySource; summary: string } {
  if (SOURCE_KINDS.has(raw.kind)) {
    const source: MemorySource = { kind: raw.kind as MemorySource["kind"] };
    if (raw.ticket !== "" && TICKET.test(raw.ticket)) source.ticketId = raw.ticket as TicketId;
    return { source, summary: raw.subject === "memory: init" ? "init" : raw.subject };
  }
  const parsed = legacySubject(raw.subject);
  const source: MemorySource = { kind: parsed.kind as MemorySource["kind"] };
  if (parsed.ticket !== undefined) source.ticketId = parsed.ticket as TicketId;
  return { source, summary: parsed.summary };
}

/**
 * A versioned store of Markdown notes. Edits only change the working tree; each conversation's edits are
 * saved together when its run ends (`commitRound`), and changes nobody made through here are saved first
 * as a separate `user` change. Every version is a "change" numbered from 1 at the first.
 */
export class MemoryRepo {
  readonly dir: string;
  #queue: Promise<unknown> = Promise.resolve();
  /** Edits in flight by round (one conversation's run): file → what was done to it. */
  readonly #rounds = new Map<string, Map<string, string[]>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  ensure(initialIndex: string): Promise<void> {
    return this.#serial(async () => {
      await mkdir(this.dir, { recursive: true });
      if ((await readText(resolveInside(this.dir, ".git/HEAD"))) !== undefined) return;
      await this.#git("init", "--quiet");
      await writeFileAtomic(resolveInside(this.dir, "MEMORY.md"), initialIndex);
      await this.#git("add", "--all");
      await this.#git(
        "commit",
        "--quiet",
        "-m",
        "memory: init",
        "-m",
        trailers({ kind: "system" }),
      );
    });
  }

  async read(file: string): Promise<string | undefined> {
    return readText(resolveInside(this.dir, file));
  }

  /** Lists all files in the repository (excluding `.git`), with `MEMORY.md` first then alphabetical. */
  async listFiles(): Promise<MemoryFileInfo[]> {
    const out: MemoryFileInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const info = await stat(full).catch(() => undefined);
          if (info === undefined) continue;
          out.push({
            path: relative(this.dir, full).replaceAll("\\", "/"),
            size: info.size,
          });
        }
      }
    };
    await walk(this.dir);
    out.sort((a, b) => {
      if (a.path === "MEMORY.md") return -1;
      if (b.path === "MEMORY.md") return 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return out;
  }

  edit(file: string, oldText: string, newText: string, round: string): Promise<void> {
    return this.#serial(async () => {
      const path = resolveInside(this.dir, file);
      const current = await readText(path);
      if (current === undefined)
        throw new MemoryConflict(`${file} does not exist; use create to make a new one.`, "");
      const at = current.indexOf(oldText);
      if (at < 0 || current.indexOf(oldText, at + 1) >= 0) {
        throw new MemoryConflict(
          `No unique match for the original text in ${file}; retry against the latest content.`,
          current,
        );
      }
      await writeFileAtomic(
        path,
        current.slice(0, at) + newText + current.slice(at + oldText.length),
      );
      this.#note(round, file, `edit ${file}`);
    });
  }

  create(file: string, content: string, round: string): Promise<void> {
    return this.#serial(async () => {
      const path = resolveInside(this.dir, file);
      const current = await readText(path);
      if (current !== undefined)
        throw new MemoryConflict(`${file} already exists; use edit to change it.`, current);
      await writeFileAtomic(path, content);
      this.#note(round, file, `create ${file}`);
    });
  }

  /** The newest changes first; anything the user edited by hand is saved as a `user` change first. */
  history(limit = 20): Promise<MemoryChange[]> {
    return this.#serial(async () => {
      await this.#saveUserEdits();
      const raw = await this.#rawChanges();
      const picked = raw.slice(-limit).reverse();
      const files = await this.#fileChangeStats(picked.length);
      return picked.map((change, i) => {
        const { source, summary } = changeSource(change);
        return { id: raw.length - i, at: change.at, source, summary, files: files[i] ?? [] };
      });
    });
  }

  /** One change with the full text of its edits. */
  show(id: number): Promise<MemoryChangeDetail> {
    return this.#serial(async () => {
      await this.#saveUserEdits();
      const raw = await this.#rawChanges();
      const change = raw[id - 1];
      if (change === undefined || id < 1) throw new ProblemError({ code: "no_change", change: id });
      const { source, summary } = changeSource(change);
      return { id, at: change.at, source, summary, files: await this.#fileDiffs(change.hash) };
    });
  }

  /** Undoes a change with a new change; one that conflicts with later edits is abandoned, changing nothing. */
  undo(id: number, source: MemorySource): Promise<MemoryChange> {
    return this.#serial(async () => {
      await this.#saveUserEdits();
      const raw = await this.#rawChanges();
      const change = raw[id - 1];
      if (change === undefined || id < 1) throw new ProblemError({ code: "no_change", change: id });
      if (id === 1) throw new ProblemError({ code: "undo_failed", change: id });
      try {
        await this.#git("revert", "--no-edit", change.hash);
      } catch {
        await this.#git("revert", "--abort").catch(() => undefined);
        throw new ProblemError({ code: "undo_failed", change: id });
      }
      await this.#git(
        "commit",
        "--quiet",
        "--amend",
        "-m",
        `Undo change #${id}`,
        "-m",
        trailers(source),
      );
      return this.#toChange(raw.length + 1, (await this.#rawChanges())[raw.length] as RawChange);
    });
  }

  /**
   * Saves the round's edits as one change, `summary` = what was done, after any edits the user made by
   * hand. Returns the new change, or `undefined` when neither produced edits.
   */
  commitRound(round: string, source: MemorySource): Promise<MemoryChange | undefined> {
    return this.#serial(async () => {
      const notes = this.#rounds.get(round);
      const changed = await this.#saveUserEdits();
      this.#rounds.delete(round);
      const ours = changed.filter((file) => notes?.has(file.path));
      if (ours.length === 0) return undefined;
      const done = ours.flatMap((file) => notes?.get(file.path) ?? []);
      await this.#git("add", "--", ...ours.map((file) => file.path));
      await this.#git("commit", "--quiet", "-m", done.join("; "), "-m", trailers(source));
      const raw = await this.#rawChanges();
      return this.#toChange(raw.length, raw[raw.length - 1] as RawChange);
    });
  }

  #note(round: string, file: string, action: string): void {
    const key = relative(this.dir, resolveInside(this.dir, file)).replaceAll("\\", "/");
    const files = this.#rounds.get(round) ?? new Map<string, string[]>();
    files.set(key, [...(files.get(key) ?? []), action]);
    this.#rounds.set(round, files);
  }

  /** Every version from the first to the latest, with its id being its 1-based position. */
  async #rawChanges(): Promise<RawChange[]> {
    const out = await this.#git(
      "log",
      "--reverse",
      "--first-parent",
      "--format=%x1e%H%x00%aI%x00%B",
    );
    return out
      .split("\x1e")
      .filter((record) => record.trim() !== "")
      .map((record) => {
        const [hash = "", at = "", ...rest] = record.split("\0");
        const lines = rest.join("\0").split("\n");
        let kind = "";
        let ticket = "";
        for (const line of lines) {
          const trailer = /^Eevee-(Source|Ticket):\s*(\S*)/.exec(line.trim());
          if (trailer?.[1] === "Source") kind = trailer[2] ?? "";
          else if (trailer?.[1] === "Ticket") ticket = trailer[2] ?? "";
        }
        const subject = (lines.find((line) => line.trim() !== "") ?? "").trim();
        return { hash, at, subject, kind, ticket };
      });
  }

  /**
   * File stats for the `count` newest changes in the same order, in two lookups at any size:
   * one pass for line counts, one for statuses.
   */
  async #fileChangeStats(count: number): Promise<MemoryFileChange[][]> {
    if (count === 0) return [];
    const records = (out: string) =>
      out
        .split("\x1e")
        .slice(1)
        .map((record) =>
          record
            .replace(/^\0+\n/, "")
            .split("\0")
            .filter((field) => field.trim() !== ""),
        );
    const [numstat, nameStatus] = await Promise.all([
      this.#git("log", `-${count}`, "--format=%x1e", "--numstat", "-z").then(records),
      this.#git("log", `-${count}`, "--format=%x1e", "--name-status", "-z").then(records),
    ]);
    const counts = numstat.map((fields) => {
      const files = new Map<string, { added: number; removed: number }>();
      for (let i = 0; i < fields.length; i++) {
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i] as string);
        if (!match) continue;
        let path = match[3] as string;
        if (path === "") {
          // A rename writes the old name, then the new one, as separate fields.
          i += 1;
          path = fields[i + 1] ?? "";
          i += 1;
        }
        if (path !== "") {
          files.set(path, {
            added: match[1] === "-" ? 0 : Number(match[1]),
            removed: match[2] === "-" ? 0 : Number(match[2]),
          });
        }
      }
      return files;
    });
    return nameStatus.map((fields, index) => {
      const files: MemoryFileChange[] = [];
      for (let i = 0; i < fields.length; i++) {
        const marker = fields[i] as string;
        if (!/^[ACDMRT]\d*$/.test(marker)) continue;
        let path = fields[i + 1] ?? "";
        if (marker.startsWith("R") || marker.startsWith("C")) {
          // A rename or copy records its old name before the new one.
          i += 1;
          path = fields[i + 1] ?? "";
        }
        i += 1;
        if (path === "") continue;
        files.push({
          path,
          status:
            marker === "A" || marker.startsWith("C")
              ? "added"
              : marker === "D"
                ? "deleted"
                : "modified",
          ...(counts[index]?.get(path) ?? { added: 0, removed: 0 }),
        });
      }
      return files;
    });
  }

  /** One raw version's parsed edits: files, statuses, counts and hunks. */
  #fileDiffs(hash: string): Promise<MemoryChangeDetail["files"]> {
    return this.#git("show", "--format=", "--no-color", "--patch", hash).then(parseDiff);
  }

  async #toChange(id: number, raw: RawChange): Promise<MemoryChange> {
    const { source, summary } = changeSource(raw);
    const files = (await this.#fileDiffs(raw.hash)).map(
      ({ hunks: _hunks, binary: _binary, ...file }) => file,
    );
    return { id, at: raw.at, source, summary, files };
  }

  /**
   * Saves every changed file no pending round claims as one `user` change; returns the changed-file
   * list either way so the caller can pick out what belongs to its own round.
   */
  async #saveUserEdits(): Promise<StatusEntry[]> {
    const changed = await this.#changedFiles();
    const noted = new Set([...this.#rounds.values()].flatMap((files) => [...files.keys()]));
    const userEdits = changed.filter((file) => !noted.has(file.path));
    if (userEdits.length > 0) {
      await this.#git("add", "--", ...userEdits.map((file) => file.path));
      const done = userEdits.map((file) => `${verb(file.status)} ${file.path}`);
      await this.#git("commit", "--quiet", "-m", done.join("; "), "-m", trailers({ kind: "user" }));
    }
    return changed;
  }

  /** The files that differ from the latest change, with whether each was added, modified or deleted. */
  async #changedFiles(): Promise<StatusEntry[]> {
    const out = await this.#git("status", "--porcelain=v1", "-z", "--untracked-files=all");
    const fields = out.split("\0").filter((field) => field !== "");
    const files: StatusEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] as string;
      const xy = field.slice(0, 2);
      const path = field.slice(3);
      if (xy.includes("R") || xy.includes("C")) i++; // a rename records its old name next
      const status = xy.includes("D")
        ? "deleted"
        : xy.includes("A") || xy === "??"
          ? "added"
          : "modified";
      files.push({ path, status });
    }
    return files;
  }

  async #git(...args: string[]): Promise<string> {
    const { stdout } = await run(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "user.name=Eevee",
        "-c",
        "user.email=eevee@localhost",
        ...args,
      ],
      { cwd: this.dir, windowsHide: true },
    );
    return stdout;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
