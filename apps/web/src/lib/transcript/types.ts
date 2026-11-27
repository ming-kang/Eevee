import type { BackgroundTaskStatus, TaskCancelReason, WorkerId } from "@eevee/protocol";

export type DiffLine = {
  readonly id: number;
  readonly k: "ctx" | "add" | "del";
  readonly text: string;
};

export type ToolStep = {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly arguments: Record<string, unknown>;
  readonly status: "pending" | "running" | "sleeping" | "waiting" | "done" | "error";
  readonly outputText?: string;
  readonly streamingOutput?: string;
  readonly isError?: boolean;
  readonly diagnostics?: readonly { readonly severity: string; readonly message: string }[];
};

export type DispatchAction = {
  readonly id: string;
  readonly tool: string;
  readonly verb: string;
  readonly target?: string;
  readonly workerId?: WorkerId;
  readonly detail?: string;
  readonly status: "run" | "ok" | "err";
};

export type ActivityKind = "read" | "edit" | "commands" | "memory" | "search" | "scripts" | "tools";
export type ActivityCount = { readonly kind: ActivityKind; readonly count: number };

export type EditSummary = {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly paths: readonly {
    readonly key: string;
    readonly path: string;
    readonly added: number;
    readonly removed: number;
  }[];
};

export type NoticeMeta = {
  readonly type: string;
  readonly workerId?: WorkerId;
  readonly workerName?: string;
  readonly ticketId?: string;
  readonly questionId?: string;
  readonly taskId?: string;
  readonly taskStatus?: BackgroundTaskStatus;
  readonly taskExitCode?: number;
  readonly taskCancelReason?: TaskCancelReason;
};

export type DisplayItem =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly at?: number;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly meta: NoticeMeta;
      readonly at?: number;
    }
  | {
      readonly kind: "thinking";
      readonly key: string;
      readonly text: string;
      readonly streaming?: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "bash";
      readonly key: string;
      readonly command: string;
      readonly status: "run" | "ok" | "err";
      readonly output: string;
      readonly at?: number;
    }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly action: "edit" | "write";
      readonly path: string;
      readonly status: "run" | "ok" | "err";
      readonly diff: readonly DiffLine[];
      readonly added: number;
      readonly removed: number;
      readonly error?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "dispatch";
      readonly key: string;
      readonly actions: readonly DispatchAction[];
      readonly live: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly steps: readonly ToolStep[];
      readonly live: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly streaming?: boolean;
      readonly error?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "compaction";
      readonly key: string;
      readonly summary: string;
      readonly at?: number;
    }
  | { readonly kind: "reset"; readonly key: string; readonly text: string; readonly at?: number }
  | {
      readonly kind: "worked";
      readonly key: string;
      readonly items: readonly DisplayItem[];
      readonly ms?: number;
      readonly activity: readonly ActivityCount[];
    };

export type LiveDocView = {
  readonly busy: boolean;
  readonly turns: number;
  readonly partialText: string;
  readonly partialThinking: string;
  readonly partialTools: readonly ToolStep[];
  readonly activeTools: readonly ToolStep[];
  readonly compacting: boolean;
  readonly runFailure?: { readonly reason: string; readonly detail?: string };
  readonly retryError?: string;
};

export type InboxPreview = {
  readonly id: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
};

export type ContextUsage = {
  readonly used: number;
  readonly cached: number;
};

export type OutlineEntry = {
  readonly key: string;
  readonly text: string;
  readonly reply?: string;
  readonly at?: number;
};

export type FindMatch = {
  readonly key: string;
  readonly hits: number;
};

export type VisualStage = "answer" | "blocked" | "working" | "queued" | "idle" | "done";
