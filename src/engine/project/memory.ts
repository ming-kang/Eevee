import { relative } from "node:path";
import { type MemoryScope, ProblemError } from "../../domain/index.ts";
import type { MemoryFileView } from "../../protocol/contract.ts";
import { resolveInside } from "../../shared/paths.ts";
import type { MemoryRepo } from "../extensions/memory/repo.ts";

export class Memory {
  readonly #repos: Record<MemoryScope, MemoryRepo>;

  constructor(repos: Record<MemoryScope, MemoryRepo>) {
    this.#repos = repos;
  }

  files(scope: MemoryScope) {
    return this.#repos[scope].listFiles();
  }

  async file(scope: MemoryScope, file: string): Promise<MemoryFileView> {
    const repo = this.#repos[scope];
    const missingFile = new ProblemError({ code: "no_memory_file", file });
    let resolved: string;
    try {
      resolved = resolveInside(repo.dir, file);
    } catch {
      throw missingFile;
    }
    const rel = relative(repo.dir, resolved).replaceAll("\\", "/");
    if (rel === ".git" || rel.startsWith(".git/")) throw missingFile;
    const content = await repo.read(rel);
    if (content === undefined) throw missingFile;
    return { path: rel, content };
  }

  history(scope: MemoryScope) {
    return this.#repos[scope].history();
  }

  show(scope: MemoryScope, change: number) {
    return this.#repos[scope].show(change);
  }

  undo(scope: MemoryScope, change: number) {
    return this.#repos[scope].undo(change, { kind: "user" });
  }
}
