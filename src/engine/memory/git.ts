import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { type FileDiff, parseDiff } from "./diff.ts";

const run = promisify(execFile);
export type GitChange = {
  hash: string;
  at: string;
  subject: string;
  trailers: Record<string, string>;
};
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted" };
type WorkingFile = ChangedFile & { needsStaging: boolean };
export type CommitMessage = { subject: string; trailers: Record<string, string> };

export class GitStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async isRepo(): Promise<boolean> {
    try {
      const root = await realpath((await this.#git("rev-parse", "--show-toplevel")).trim());
      const dir = await realpath(this.#dir);
      return process.platform === "win32" ? root.toLowerCase() === dir.toLowerCase() : root === dir;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await this.#git("init", "--quiet");
  }

  async changedFiles(): Promise<ChangedFile[]> {
    return (await this.#status()).map(({ needsStaging: _needsStaging, ...file }) => file);
  }

  async #status(): Promise<WorkingFile[]> {
    const fields = (
      await this.#git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    ).split("\0");
    const files: WorkingFile[] = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field) continue;
      const xy = field.slice(0, 2);
      const path = field.slice(3);
      files.push({
        path,
        status: xy.includes("D") ? "deleted" : /[ARC?]/.test(xy) ? "added" : "modified",
        needsStaging: xy[1] !== " ",
      });
      if (xy.includes("R") || xy.includes("C")) {
        const from = fields[++i];
        if (from && xy.includes("R"))
          files.push({ path: from, status: "deleted", needsStaging: xy[0] !== "R" });
      }
    }
    return files;
  }

  async commit(paths: readonly string[] | "all", message: CommitMessage): Promise<string> {
    await this.writeCommit(paths, message);
    return (await this.#git("rev-parse", "HEAD")).trim();
  }

  async writeCommit(paths: readonly string[] | "all", message: CommitMessage): Promise<void> {
    if (paths === "all") await this.#git("add", "--all");
    else {
      const unstaged = (await this.#status()).filter(
        (file) => file.needsStaging && paths.includes(file.path),
      );
      if (unstaged.length > 0) await this.#git("add", "--", ...unstaged.map((file) => file.path));
    }
    await this.#git(
      "commit",
      "--quiet",
      "-m",
      message.subject,
      "-m",
      Object.entries(message.trailers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
      ...(paths === "all" ? [] : ["--only", "--", ...paths]),
    );
  }

  async resetIndex(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) await this.#git("reset", "-q", "HEAD", "--", ...paths);
  }

  async log(): Promise<GitChange[]> {
    if (!(await this.#git("rev-parse", "--verify", "HEAD").catch(() => ""))) return [];
    const out = await this.#git(
      "log",
      "--reverse",
      "--first-parent",
      "--format=%x1e%H%x00%aI%x00%s%x00%(trailers:only,unfold)",
    );
    return out
      .split("\x1e")
      .filter((record) => record.trim() !== "")
      .map((record) => {
        const [hash = "", at = "", subject = "", block = ""] = record.split("\0");
        const trailers: Record<string, string> = {};
        for (const line of block.trimEnd().split("\n")) {
          const match = /^([^:\s]+):\s*(.*)$/.exec(line);
          if (match) trailers[match[1] as string] = match[2] ?? "";
        }
        return { hash, at, subject, trailers };
      });
  }

  async diff(hash: string): Promise<FileDiff[]> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid revision");
    return parseDiff(
      await this.#git("show", "--format=", "--no-color", "--patch", "--root", hash, "--"),
    );
  }

  async content(hash: string, file: string, parent = false): Promise<string | undefined> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid revision");
    const revision = hash + (parent ? "^" : "");
    if (!(await this.#git("ls-tree", "-z", revision, "--", file))) return undefined;
    return this.#git("show", `${revision}:${file}`);
  }

  async fileChanges(hash: string): Promise<ChangedFile[]> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid revision");
    const fields = (
      await this.#git(
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--no-renames",
        "--name-status",
        "-z",
        hash,
        "--",
      )
    ).split("\0");
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const marker = fields[i];
      const path = fields[i + 1];
      if (path)
        files.push({
          path,
          status: marker === "A" ? "added" : marker === "D" ? "deleted" : "modified",
        });
    }
    return files;
  }

  async revert(hash: string): Promise<{ ok: true } | { conflict: true }> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid revision");
    try {
      await this.#git("revert", "--no-commit", hash);
      await this.#git("revert", "--quit");
      return { ok: true };
    } catch {
      await this.#git("revert", "--abort");
      return { conflict: true };
    }
  }

  async #git(...args: string[]): Promise<string> {
    const { stdout } = await run(
      "git",
      [
        "--literal-pathspecs",
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
      { cwd: this.#dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  }
}
