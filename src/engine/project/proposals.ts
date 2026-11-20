import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import {
  isMemoryUndo,
  type MemoryChange,
  type MemoryProposal,
  type MemoryScope,
  ProblemError,
  type ProposalId,
  proposalId,
} from "../../domain/index.ts";
import type { MemoryProposalView } from "../../protocol/views.ts";
import { Board, ProposalDoc } from "../docs.ts";
import { MemoryConflict, type MemoryStore } from "../memory/store.ts";
import type { Dispatch } from "./dispatch.ts";

type Deps = {
  project: string;
  harness: Harness;
  context: Context;
  dispatch: Dispatch;
  stores: Record<MemoryScope, MemoryStore>;
};

export class Proposals {
  readonly #deps: Deps;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async list(): Promise<MemoryProposal[]> {
    const board = await this.#deps.harness.snapshot(Board, this.#deps.context);
    const ids = new Set(board?.openProposals ?? []);
    let recent = 0;
    for (let n = (board?.nextProposal ?? 1) - 1; n > 0 && recent < 30; n--) {
      const id = proposalId(n);
      const proposal = await this.#read(id);
      if (proposal && proposal.status !== "pending") {
        ids.add(id);
        recent++;
      }
    }
    const proposals = await Promise.all([...ids].map((id) => this.#read(id)));
    return proposals
      .filter((p): p is MemoryProposal => p !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: ProposalId): Promise<MemoryProposalView> {
    const proposal = await this.#require(id);
    if (proposal.status === "approved" && proposal.change)
      return {
        ...proposal,
        files: (await this.#deps.stores[proposal.scope].show(proposal.change.id)).files,
      };
    try {
      return {
        ...proposal,
        files: await this.#deps.stores[proposal.scope].preview(proposal.actions),
      };
    } catch (error) {
      if (!(error instanceof MemoryConflict || error instanceof ProblemError)) throw error;
      return { ...proposal, files: [], conflict: error.message };
    }
  }

  approve(id: ProposalId): Promise<MemoryChange> {
    return this.#serial(async () => {
      const proposal = await this.#pending(id);
      const store = this.#deps.stores[proposal.scope];
      let change: MemoryChange | undefined;
      try {
        change = isMemoryUndo(proposal.actions)
          ? await store.undo(proposal.actions[0].change, proposal.source, {
              versions: proposal.actions[0].versions,
              request: this.#request(id),
            })
          : await store.apply(
              proposal.actions,
              proposal.source,
              proposal.summary,
              this.#request(id),
            );
        if (!change) throw new MemoryConflict("", "No text changes remain.", "");
      } catch (error) {
        if (!(error instanceof MemoryConflict || error instanceof ProblemError)) throw error;
        const file =
          error instanceof MemoryConflict
            ? error.file
            : error.problem.code === "memory_changed"
              ? error.problem.file
              : "";
        await this.#finish({ ...proposal, status: "stale", reason: error.message }, file);
        throw new ProblemError({ code: "memory_changed", file });
      }
      await this.#finish({ ...proposal, status: "approved", change });
      return change;
    });
  }

  reject(id: ProposalId, reason?: string): Promise<void> {
    return this.#serial(async () => {
      const proposal = await this.#pending(id);
      const applied = await this.#deps.stores[proposal.scope].requestChange(this.#request(id));
      if (applied) {
        await this.#finish({ ...proposal, status: "approved", change: applied });
        throw new ProblemError({ code: "proposal_decided", proposalId: id });
      }
      await this.#finish({ ...proposal, status: "rejected", ...(reason ? { reason } : {}) });
    });
  }

  async close(): Promise<void> {
    await this.#tail;
  }
  #request(id: ProposalId): string {
    return `${this.#deps.project}:${id}`;
  }
  #read(id: ProposalId) {
    return this.#deps.harness.snapshot(ProposalDoc, id, this.#deps.context);
  }
  async #require(id: ProposalId): Promise<MemoryProposal> {
    const proposal = await this.#read(id);
    if (!proposal) throw new ProblemError({ code: "no_proposal", proposalId: id });
    return proposal;
  }
  async #pending(id: ProposalId): Promise<MemoryProposal> {
    const proposal = await this.#require(id);
    if (proposal.status !== "pending")
      throw new ProblemError({ code: "proposal_decided", proposalId: id });
    return proposal;
  }
  async #finish(proposal: MemoryProposal, file?: string): Promise<void> {
    await this.#deps.dispatch(
      { type: "proposal-decided", proposal, ...(file ? { file } : {}) },
      async (tx) => {
        const current = await tx.doc(ProposalDoc, proposal.id, null);
        if (current.status !== "pending")
          throw new ProblemError({ code: "proposal_decided", proposalId: proposal.id });
        Object.assign(current, proposal, { decidedAt: Date.now() });
        const board = await tx.doc(Board);
        board.openProposals = board.openProposals.filter((id) => id !== proposal.id);
      },
    );
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action);
    this.#tail = result.catch(() => {});
    return result;
  }
}
