import type { ModelChoice, RoleName } from "../../domain/index.ts";
import type { BoardView, ProjectSummary, UsageView } from "../../protocol/contract.ts";
import type { BoardFeed, BoardListener } from "../board-feed.ts";
import type { Conversations } from "./conversations.ts";
import type { Jobs } from "./jobs.ts";
import type { Memory } from "./memory.ts";
import type { Proposals } from "./proposals.ts";
import type { Questions } from "./questions.ts";
import type { ProjectSettings } from "./settings.ts";
import type { ProjectMeta, ProjectStore } from "./store.ts";

type Parts = {
  store: ProjectStore;
  settings: ProjectSettings;
  conversations: Conversations;
  questions: Questions;
  proposals: Proposals;
  jobs: Jobs;
  memory: Memory;
  feed: BoardFeed;
  activeAt: () => number;
  usage: () => Promise<UsageView>;
  close: () => Promise<void>;
  changed?: () => void;
};

export class Project {
  readonly conversations: Conversations;
  readonly questions: Questions;
  readonly proposals: Proposals;
  readonly jobs: Jobs;
  readonly memory: Memory;
  readonly #parts: Parts;

  constructor(parts: Parts) {
    this.#parts = parts;
    this.conversations = parts.conversations;
    this.questions = parts.questions;
    this.proposals = parts.proposals;
    this.jobs = parts.jobs;
    this.memory = parts.memory;
  }

  get meta(): ProjectMeta {
    return this.#parts.store.current;
  }

  summary(): ProjectSummary {
    return { ...this.meta, activeAt: this.#parts.activeAt() };
  }

  board(): Promise<BoardView> {
    return this.#parts.feed.read();
  }

  watchBoard(listener: BoardListener): () => void {
    return this.#parts.feed.subscribe(listener);
  }

  usage(): Promise<UsageView> {
    return this.#parts.usage();
  }

  async setModel(role: RoleName | "default", choice: ModelChoice | null): Promise<void> {
    await this.#parts.settings.setModel(role, choice);
    this.#parts.changed?.();
  }

  applyModels(): Promise<void> {
    return this.#parts.settings.applyModels();
  }

  refreshExtensions(): Promise<void> {
    return this.#parts.settings.refreshExtensions();
  }

  close(): Promise<void> {
    return this.#parts.close();
  }
}
