import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { Extension, JsonObject } from "@earendil-works/pi-durable";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings.ts";
import { eeveePaths } from "../shared/paths.ts";
import { MemoryStore } from "./memory/store.ts";
import { openProject } from "./project/open.ts";
import type { Project } from "./project/project.ts";
import { createProjectMeta } from "./project/store.ts";

export type Turn = {
  role: "router" | "worker" | "dreamer";
  messages: readonly Message[];
  /** The last message other than a system one (which only adds instructions or tools). */
  last: Message | undefined;
  /** Names of the tools offered to the model. */
  tools: string[];
  /** The model asked. */
  model: string;
  /** The thinking level the request asked for; `off` sends none. */
  thinking: string;
};

type Reply = ReturnType<typeof fauxAssistantMessage>;

export type Brain = (turn: Turn) => Reply | Promise<Reply>;

export const say = (text: string) => fauxAssistantMessage(fauxText(text));

export const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

export function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part.text ?? "").join("");
}

export function toolName(message: Message | undefined): string | undefined {
  return message?.role === "toolResult" ? message.toolName : undefined;
}

/** The tools the system messages of a request leave available, in order. */
function offeredTools(messages: readonly Message[]): string[] {
  const tools: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? []) {
      const at = tools.indexOf(removed.name);
      if (at >= 0) tools.splice(at, 1);
    }
    for (const added of message.toolsAdded ?? []) {
      if (!tools.includes(added.name)) tools.push(added.name);
    }
  }
  return tools;
}

export type TestProject = {
  host: Project;
  home: string;
  workspace: string;
  settings: Settings;
  calls: Turn[];
  until<T>(probe: () => Promise<T | undefined | false>, timeoutMs?: number): Promise<T>;
  reopen(): Promise<void>;
  close(): Promise<void>;
};

export type TestOptions = Partial<Settings> & {
  contextWindow?: number;
  /** Models of the `faux` provider besides `brain`. */
  extraModels?: string[];
  /** Extensions installed as the Engine's shared ones. */
  shared?: Extension[];
};

export async function openTestProject(
  brain: Brain,
  { contextWindow, shared = [], extraModels = [], ...overrides }: TestOptions = {},
): Promise<TestProject> {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "eevee-test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "eevee@test.invalid";
  const home = await mkdtemp(join(tmpdir(), "eevee-e2e-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const paths = eeveePaths(home);

  const calls: Turn[] = [];
  const faux = fauxProvider({
    provider: "faux",
    models: ["brain", ...extraModels].map((id) => ({
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })),
  });
  const factory: FauxResponseFactory = (context, options, _state, model) => {
    const serialized = JSON.stringify(context.messages.filter((m) => m.role !== "toolResult"));
    const role = serialized.includes(
      "You are Eevee's Router, the user's only conversation partner.",
    )
      ? "router"
      : serialized.includes("You keep the project's memory store in order.")
        ? "dreamer"
        : "worker";
    const turn: Turn = {
      role,
      messages: context.messages,
      last: context.messages.findLast((m) => m.role !== "system"),
      tools: offeredTools(context.messages),
      model: model.id,
      thinking: options?.reasoning ?? "off",
    };
    calls.push(turn);
    return brain(turn);
  };
  faux.setResponses(Array.from({ length: 200 }, () => factory));
  const models = createModels();
  models.setProvider(faux.provider);

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    models: { default: { provider: "faux", modelId: "brain" } },
    // Dreaming stays off in tests unless one asks for it; its trigger would open tickets of its own.
    dreaming: { ...DEFAULT_SETTINGS.dreaming, enabled: false },
    ...overrides,
  };
  const meta = await createProjectMeta(paths, { title: "Test project", workspace });
  const open = () =>
    openProject({
      paths,
      meta,
      models: () => models,
      settings: () => settings,
      globalMemory: new MemoryStore(paths.globalMemory, "global"),
      shared: () => shared,
      context: BACKGROUND_CONTEXT,
      upkeepMs: 100,
    });

  const project: TestProject = {
    host: await open(),
    home,
    workspace,
    settings,
    calls,
    async until(probe, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined && value !== false) return value as never;
        await sleep(20);
      }
      throw new Error("Timed out waiting");
    },
    async reopen() {
      await project.host.close();
      project.host = await open();
    },
    async close() {
      await project.host.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return project;
}
