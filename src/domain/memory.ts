import type { MemoryScope } from "./address.ts";
import type { MemoryChange, MemorySource } from "./domain.ts";

export type ProposalId = `m${number}`;
export const proposalId = (n: number): ProposalId => `m${n}`;
export type MemoryOp = (
  | { action: "create"; file: string; content: string }
  | { action: "edit"; file: string; oldText: string; newText: string }
  | { action: "write"; file: string; content: string }
  | { action: "delete"; file: string }
  | { action: "rename"; from: string; to: string; toVersion?: string }
) & { version?: string };
export type MemoryUndo = { action: "undo"; change: number; versions: Record<string, string> };
export type MemoryActions = MemoryOp[] | [MemoryUndo];
export const isMemoryUndo = (actions: MemoryActions): actions is [MemoryUndo] =>
  actions.length === 1 && actions[0]?.action === "undo";
export type AgentMemorySource = Omit<MemorySource, "kind"> & { kind: "router" | "dreaming" };
export type MemoryProposal = {
  id: ProposalId;
  scope: MemoryScope;
  source: AgentMemorySource;
  conversationId: number;
  summary: string;
  actions: MemoryActions;
  status: "pending" | "approved" | "rejected" | "stale";
  createdAt: number;
  decidedAt?: number;
  reason?: string;
  change?: MemoryChange;
};
