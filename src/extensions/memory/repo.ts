import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import { readText, writeFileAtomic } from "../../shared/fs.ts";
import { resolveInside } from "../../shared/paths.ts";

const run = promisify(execFile);

export class MemoryConflict extends Error {
  override name = "MemoryConflict";
  readonly current: string;

  constructor(message: string, current: string) {
    super(message);
    this.current = current;
  }
}

/** A history operation that cannot be done: an unknown commit, or a revert that conflicts. */
export class MemoryHistoryError extends Error {
  override name = "MemoryHistoryError";
}

export type MemoryCommit = { commit: string; at: string; subject: string };

const COMMIT = /^[0-9a-f]{4,40}$/i;

function commitRef(commit: string): string {
  if (!COMMIT.test(commit)) throw new MemoryHistoryError(`不是 commit 编号：${commit}`);
  return commit;
}

/**
 * A Git repository of Markdown notes. Edits only change the working tree; each conversation's edits are
 * committed together when its run ends (`commitRound`), and changes nobody made through here are committed
 * first as a separate `user edit`.
 */
export class MemoryRepo {
  readonly dir: string;
  #queue: Promise<unknown> = Promise.resolve();
  /** Uncommitted edits by round (one conversation's run): file → what was done to it. */
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
      await this.#git("commit", "--quiet", "-m", "memory: init");
    });
  }

  async read(file: string): Promise<string | undefined> {
    return readText(resolveInside(this.dir, file));
  }

  edit(file: string, oldText: string, newText: string, round: string): Promise<void> {
    return this.#serial(async () => {
      const path = resolveInside(this.dir, file);
      const current = await readText(path);
      if (current === undefined) throw new MemoryConflict(`${file} 不存在，新建请用 create。`, "");
      const at = current.indexOf(oldText);
      if (at < 0 || current.indexOf(oldText, at + 1) >= 0) {
        throw new MemoryConflict(`${file} 里找不到唯一匹配的原文，请按最新内容重试。`, current);
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
        throw new MemoryConflict(`${file} 已存在，修改请用 edit。`, current);
      await writeFileAtomic(path, content);
      this.#note(round, file, `create ${file}`);
    });
  }

  /** The newest commits first. */
  async history(limit = 20): Promise<MemoryCommit[]> {
    const out = await this.#git("log", `-${limit}`, "--format=%h%x09%aI%x09%s");
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [commit = "", at = "", ...subject] = line.split("\t");
        return { commit, at, subject: subject.join("\t") };
      });
  }

  async log(limit = 20): Promise<string> {
    return (await this.history(limit))
      .map((c) => `${c.commit} ${c.at.slice(0, 10)} ${c.subject}`)
      .join("\n");
  }

  /** One commit's changes, or the uncommitted ones without `commit`. */
  async diff(commit?: string): Promise<string> {
    if (commit === undefined) return this.#git("diff", "HEAD");
    const ref = commitRef(commit);
    try {
      return await this.#git("show", "--stat", "--patch", ref);
    } catch {
      throw new MemoryHistoryError(`没有 commit ${commit}`);
    }
  }

  /** Undoes a commit with a new one; a revert that conflicts is abandoned and changes nothing. */
  async revert(commit: string): Promise<void> {
    const ref = commitRef(commit);
    await this.#serial(async () => {
      try {
        await this.#git("revert", "--no-edit", ref);
      } catch {
        await this.#git("revert", "--abort").catch(() => undefined);
        throw new MemoryHistoryError(
          `撤销 ${commit} 失败：没有这个 commit，或后来的改动（含还没提交的）与它冲突。`,
        );
      }
    });
  }

  /** Commits the round's edits as one commit, `<label>: <what was done>`, after any user edits. */
  commitRound(round: string, label: string): Promise<void> {
    return this.#serial(async () => {
      const changed = await this.#changedFiles();
      if (changed.length === 0) return;
      const noted = new Set([...this.#rounds.values()].flatMap((files) => [...files.keys()]));
      const userEdits = changed.filter((file) => !noted.has(file));
      if (userEdits.length > 0) {
        await this.#git("add", "--", ...userEdits);
        await this.#git("commit", "--quiet", "-m", "user edit");
      }
      const notes = this.#rounds.get(round);
      this.#rounds.delete(round);
      const ours = changed.filter((file) => notes?.has(file));
      if (ours.length > 0) {
        const done = ours.flatMap((file) => notes?.get(file) ?? []);
        await this.#git("add", "--", ...ours);
        await this.#git("commit", "--quiet", "-m", `${label}: ${done.join("; ")}`);
      }
    });
  }

  #note(round: string, file: string, action: string): void {
    const key = relative(this.dir, resolveInside(this.dir, file)).replaceAll("\\", "/");
    const files = this.#rounds.get(round) ?? new Map<string, string[]>();
    files.set(key, [...(files.get(key) ?? []), action]);
    this.#rounds.set(round, files);
  }

  async #changedFiles(): Promise<string[]> {
    const status = await this.#git("status", "--porcelain", "--untracked-files=all");
    return status
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  }

  async #git(...args: string[]): Promise<string> {
    const { stdout } = await run("git", args, { cwd: this.dir, windowsHide: true });
    return stdout;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
