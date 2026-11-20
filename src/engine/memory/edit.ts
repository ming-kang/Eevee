import { ProblemError } from "../../domain/index.ts";
import { MemoryConflict, type MemoryOp, type MemoryStore } from "./store.ts";

async function apply(store: MemoryStore, op: MemoryOp) {
  try {
    return await store.apply([op], { kind: "user" });
  } catch (error) {
    if (error instanceof MemoryConflict) throw new ProblemError({ code: "invalid", field: "file" });
    throw error;
  }
}

export async function putMemoryFile(
  store: MemoryStore,
  file: string,
  content: string,
  version?: string,
) {
  return (await apply(store, { action: "write", file, content, version })) ?? store.file(file);
}

export async function deleteMemoryFile(store: MemoryStore, file: string, version?: string) {
  const change = await apply(store, { action: "delete", file, version });
  if (!change) throw new ProblemError({ code: "no_memory_file", file });
  return change;
}

export async function renameMemoryFile(
  store: MemoryStore,
  file: string,
  to: string,
  version?: string,
) {
  const change = await apply(store, { action: "rename", from: file, to, version });
  if (!change) throw new ProblemError({ code: "invalid", field: "to" });
  return change;
}
