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
import type { JsonObject } from "@earendil-works/pi-durable";
import { MemoryRepo } from "../extensions/memory/index.ts";
import { eeveePaths } from "../shared/paths.ts";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings.ts";
import { createProjectMeta } from "./project.ts";
import { ProjectHost } from "./project-host.ts";

export type Turn = {
  role: "router" | "worker";
  messages: readonly Message[];
  last: Message | undefined;
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

export type TestProject = {
  host: ProjectHost;
  home: string;
  workspace: string;
  settings: Settings;
  calls: Turn[];
  until<T>(probe: () => Promise<T | undefined | false>, timeoutMs?: number): Promise<T>;
  reopen(): Promise<void>;
  close(): Promise<void>;
};

export type TestOptions = Partial<Settings> & { contextWindow?: number };

export async function openTestProject(
  brain: Brain,
  { contextWindow, ...overrides }: TestOptions = {},
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
    models: [{ id: "brain", ...(contextWindow === undefined ? {} : { contextWindow }) }],
  });
  const factory: FauxResponseFactory = (context) => {
    const serialized = JSON.stringify(context.messages.filter((m) => m.role !== "toolResult"));
    const role = serialized.includes("你是 Eevee 的调度者") ? "router" : "worker";
    const turn = { role, messages: context.messages, last: context.messages.at(-1) } as const;
    calls.push(turn);
    return brain(turn);
  };
  faux.setResponses(Array.from({ length: 200 }, () => factory));
  const models = createModels();
  models.setProvider(faux.provider);

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    models: { default: { provider: "faux", modelId: "brain" } },
    ...overrides,
  };
  const meta = await createProjectMeta(paths, { title: "测试项目", workspace });
  const open = () =>
    ProjectHost.open({
      paths,
      meta,
      models: () => models,
      settings: () => settings,
      globalMemory: new MemoryRepo(paths.globalMemory),
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
      throw new Error("等待超时");
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
