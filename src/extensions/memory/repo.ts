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

export class MemoryRepo {
  readonly dir: string;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #round = new Map<string, string[]>();

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

  edit(file: string, oldText: string, newText: string): Promise<void> {
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
      this.#note(file, `edit ${file}`);
    });
  }

  create(file: string, content: string): Promise<void> {
    return this.#serial(async () => {
      const path = resolveInside(this.dir, file);
      const current = await readText(path);
      if (current !== undefined)
        throw new MemoryConflict(`${file} 已存在，修改请用 edit。`, current);
      await writeFileAtomic(path, content);
      this.#note(file, `create ${file}`);
    });
  }

  log(limit = 20): Promise<string> {
    return this.#git("log", `-${limit}`, "--format=%h %ad %s", "--date=short");
  }

  diff(commit?: string): Promise<string> {
    return commit === undefined
      ? this.#git("diff", "HEAD")
      : this.#git("show", "--stat", "--patch", commit);
  }

  revert(commit: string): Promise<string> {
    return this.#serial(() => this.#git("revert", "--no-edit", commit));
  }

  commitRound(): Promise<void> {
    return this.#serial(async () => {
      const changed = await this.#changedFiles();
      if (changed.length === 0) return;
      const userEdits = changed.filter((file) => !this.#round.has(file));
      if (userEdits.length > 0) {
        await this.#git("add", "--", ...userEdits);
        await this.#git("commit", "--quiet", "-m", "user edit");
      }
      const ours = changed.filter((file) => this.#round.has(file));
      if (ours.length > 0) {
        const notes = ours.flatMap((file) => this.#round.get(file) ?? []);
        await this.#git("add", "--", ...ours);
        await this.#git("commit", "--quiet", "-m", `memory: ${notes.join("; ")}`);
      }
      this.#round.clear();
    });
  }

  #note(file: string, action: string): void {
    const key = relative(this.dir, resolveInside(this.dir, file)).replaceAll("\\", "/");
    this.#round.set(key, [...(this.#round.get(key) ?? []), action]);
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
