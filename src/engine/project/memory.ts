import type { MemoryScope } from "../../domain/index.ts";
import type { MemoryFileView } from "../../protocol/contract.ts";
import { deleteMemoryFile, putMemoryFile, renameMemoryFile } from "../memory/edit.ts";
import type { MemoryStore } from "../memory/store.ts";

export const INITIAL_GLOBAL_MEMORY =
  "# Global memory\n\nCross-project preferences about the user themselves; keep it very short.\n";

export class Memory {
  readonly #repos: Record<MemoryScope, MemoryStore>;

  constructor(repos: Record<MemoryScope, MemoryStore>) {
    this.#repos = repos;
  }

  files(scope: MemoryScope) {
    return this.#repos[scope].files();
  }

  async file(scope: MemoryScope, file: string): Promise<MemoryFileView> {
    return this.#repos[scope].file(file);
  }

  history(scope: MemoryScope) {
    return this.#repos[scope].history();
  }

  put(scope: MemoryScope, file: string, content: string, version?: string) {
    return putMemoryFile(this.#repos[scope], file, content, version);
  }

  delete(scope: MemoryScope, file: string, version?: string) {
    return deleteMemoryFile(this.#repos[scope], file, version);
  }

  rename(scope: MemoryScope, file: string, to: string, version?: string) {
    return renameMemoryFile(this.#repos[scope], file, to, version);
  }

  show(scope: MemoryScope, change: number) {
    return this.#repos[scope].show(change);
  }

  undo(scope: MemoryScope, change: number) {
    return this.#repos[scope].undo(change, { kind: "user" });
  }
}
