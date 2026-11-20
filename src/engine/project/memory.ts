import type { MemoryScope } from "../../domain/index.ts";
import type { MemoryFileView } from "../../protocol/contract.ts";
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

  show(scope: MemoryScope, change: number) {
    return this.#repos[scope].show(change);
  }

  undo(scope: MemoryScope, change: number) {
    return this.#repos[scope].undo(change, { kind: "user" });
  }
}
