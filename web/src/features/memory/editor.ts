import { ref } from "vue";
import type { MemoryScope } from "../../../../src/domain/index.ts";
import { ApiRequestError, type Client } from "../../../../src/protocol/client.ts";
import { errorText } from "../../lib/errors.ts";

export type EditorMode = "edit" | "new" | "delete" | "rename";
export type MemoryDraft = {
  mode: EditorMode;
  scope: MemoryScope;
  project: string;
  file: string;
  name: string;
  content: string;
  version: string;
  loaded: boolean;
  missing: boolean;
};

export function createMemoryEditor(
  client: Client,
  project: () => string,
  saved: (draft: MemoryDraft) => Promise<void>,
) {
  const draft = ref<MemoryDraft>();
  const busy = ref(false);
  const error = ref<string>();
  const changed = ref(false);
  let sequence = 0;

  function close(): void {
    sequence++;
    draft.value = undefined;
    busy.value = false;
    error.value = undefined;
    changed.value = false;
  }

  async function reload(): Promise<void> {
    const target = draft.value;
    if (!target || busy.value) return;
    if (target.mode === "new") target.file = target.name;
    const token = ++sequence;
    busy.value = true;
    error.value = undefined;
    try {
      const file =
        target.scope === "global"
          ? await client.call("GET /api/memory/files/:file", { file: target.file })
          : await client.call("GET /api/projects/:project/memory/files/:file", {
              project: target.project,
              file: target.file,
            });
      if (token !== sequence) return;
      target.content = file.content;
      target.version = file.version;
      target.missing = false;
      target.loaded = true;
      if (target.mode === "new") target.mode = "edit";
      changed.value = false;
    } catch (cause) {
      if (token !== sequence) return;
      if (cause instanceof ApiRequestError && cause.problem.code === "no_memory_file") {
        target.content = "";
        target.version = "";
        target.missing = true;
        target.loaded =
          (target.mode === "edit" || target.mode === "new") && target.scope === "project";
        changed.value = false;
      }
      error.value = errorText(cause);
    } finally {
      if (token === sequence) busy.value = false;
    }
  }

  async function open(mode: EditorMode, scope: MemoryScope, file = ""): Promise<void> {
    close();
    draft.value = {
      mode,
      scope,
      project: project(),
      file,
      name: file,
      content: "",
      version: "",
      loaded: mode === "new",
      missing: mode === "new",
    };
    if (mode !== "new") await reload();
  }

  async function submit(): Promise<void> {
    const target = draft.value;
    if (!target || busy.value || !target.loaded) return;
    const token = ++sequence;
    busy.value = true;
    error.value = undefined;
    changed.value = false;
    try {
      const params = { project: target.project, file: target.file };
      if (target.mode === "delete") {
        if (target.scope === "global")
          await client.call("DELETE /api/memory/files/:file", {
            file: target.file,
            query: { version: target.version },
          });
        else
          await client.call("DELETE /api/projects/:project/memory/files/:file", {
            ...params,
            query: { version: target.version },
          });
      } else if (target.mode === "rename") {
        const body = { to: target.name, version: target.version };
        if (target.scope === "global")
          await client.call("POST /api/memory/files/:file/rename", { file: target.file }, body);
        else
          await client.call("POST /api/projects/:project/memory/files/:file/rename", params, body);
      } else {
        const file = target.mode === "new" ? target.name : target.file;
        const body = { content: target.content, version: target.version };
        if (target.scope === "global")
          await client.call("PUT /api/memory/files/:file", { file }, body);
        else
          await client.call(
            "PUT /api/projects/:project/memory/files/:file",
            { ...params, file },
            body,
          );
      }
    } catch (cause) {
      if (token === sequence) {
        error.value = errorText(cause);
        changed.value = cause instanceof ApiRequestError && cause.problem.code === "memory_changed";
      }
      return;
    } finally {
      if (token === sequence) busy.value = false;
    }
    if (token !== sequence) return;
    close();
    await saved(target);
  }

  return { draft, busy, error, changed, open, close, reload, submit };
}

export type MemoryEditor = ReturnType<typeof createMemoryEditor>;
