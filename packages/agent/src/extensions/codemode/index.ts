import type { Context } from "@earendil-works/chord/context";
import type {
  CodemodeSandboxOptions,
  InlineCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";
import {
  CodemodeSandbox,
  type CodemodeSandboxBase,
  InlineCodemodeSandbox,
  loadQuickJSWasm,
} from "@earendil-works/pi-codemode";
import { defineExtension, type Extension, type PromptInput } from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  type CodemodeToolOptions,
  createCodemodeExtension as createUpstreamCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import { resolveToolPromptMeta, withToolPromptMeta } from "../../context/tool-meta.ts";

export const CODEMODE_EXTENSION = "eevee.codemode";

export type CodemodeExtensionOptions = Omit<CodemodeToolOptions, "inlineBudget"> & {
  readonly inlineBudget?: number | (() => number | undefined);
};

export function createCodemodeExtension(options: CodemodeExtensionOptions): Extension {
  const initialBudget =
    typeof options.inlineBudget === "function" ? options.inlineBudget() : options.inlineBudget;
  const upstream = createUpstreamCodemodeExtension({ ...options, inlineBudget: initialBudget });
  const tools = (upstream.tools ?? []).map((tool) =>
    tool.name === CODEMODE_TOOL_NAME
      ? withToolPromptMeta(tool, {
          promptSnippet: "Run JavaScript that calls other tools",
          promptGuidelines: [
            "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
          ],
        })
      : tool,
  );
  const sections = (upstream.sections ?? []).map((entry) => {
    if (entry.key !== "codemode") return entry;
    return {
      ...entry,
      render: (input: PromptInput, context: Context) => {
        const budget =
          typeof options.inlineBudget === "function"
            ? options.inlineBudget()
            : options.inlineBudget;
        const renderEntry =
          typeof options.inlineBudget === "function"
            ? ((
                createUpstreamCodemodeExtension({ ...options, inlineBudget: budget }).sections ?? []
              ).find((candidate) => candidate.key === "codemode") ?? entry)
            : entry;
        const callable = input.agent.callable.map((tool) => {
          const guidelines =
            resolveToolPromptMeta(tool, input.agent.extensions)?.promptGuidelines ?? [];
          const bullets = guidelines
            .map((guideline) => guideline.trim())
            .filter((guideline) => guideline !== "")
            .map((guideline) => `- ${guideline}`);
          if (bullets.length === 0) return tool;
          return {
            ...tool,
            description: `${tool.description.trim()}\n\n${bullets.join("\n")}`,
          };
        });
        return renderEntry.render({ ...input, agent: { ...input.agent, callable } }, context);
      },
    };
  });
  return defineExtension({ ...upstream, name: CODEMODE_EXTENSION, tools, sections });
}

export type CodemodeHandleOptions = Omit<CodemodeToolOptions, "sandbox" | "inlineBudget"> & {
  readonly sandbox?: CodemodeSandboxBase;
  readonly inlineBudget?: number | (() => number | undefined);
  readonly mode?: "worker" | "inline";
  readonly sandboxOptions?: CodemodeSandboxOptions;
  readonly inlineOptions?: InlineCodemodeSandboxOptions;
};

export type CodemodeHandle = {
  readonly extension: Extension;
  readonly sandbox: CodemodeSandboxBase;
  close(): Promise<void>;
};

export function createCodemodeHandle(options: CodemodeHandleOptions = {}): CodemodeHandle {
  const { sandbox: provided, mode, sandboxOptions, inlineOptions, ...toolOptions } = options;
  const owned = provided === undefined;
  const sandbox =
    provided ??
    (mode === "inline"
      ? // `wasm` is required by the inline sandbox but optional here: on Node the
        // package's own QuickJS build is the default, overridable through `inlineOptions`.
        new InlineCodemodeSandbox({ wasm: loadQuickJSWasm(), ...inlineOptions })
      : new CodemodeSandbox(sandboxOptions));
  const extension = createCodemodeExtension({ ...toolOptions, sandbox });
  return {
    extension,
    sandbox,
    // A caller-supplied sandbox keeps its owner: closing the handle must not
    // close what the caller may still use or close itself.
    close: async () => {
      if (owned) await sandbox.close();
    },
  };
}

export type {
  CodemodeSandboxOptions,
  InlineCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";
export {
  CodemodeSandbox,
  CodemodeSandboxBase,
  InlineCodemodeSandbox,
} from "@earendil-works/pi-codemode";
export type {
  CodemodeGlobal,
  CodemodeNestedCall,
  CodemodeToolDetails,
  CodemodeToolOptions,
} from "@earendil-works/pi-durable/codemode";
export {
  CODEMODE_TOOL_NAME,
  CodemodeStoreDoc,
  DEFAULT_CODEMODE_INLINE_BUDGET,
} from "@earendil-works/pi-durable/codemode";
