import type { Tx } from "@earendil-works/pi-durable";
import { type MemoryProposal, proposalId } from "../../domain/index.ts";
import { Board, ProposalDoc } from "../docs.ts";

export async function addProposal(
  tx: Tx,
  draft: Omit<MemoryProposal, "id" | "status">,
): Promise<MemoryProposal> {
  const board = await tx.doc(Board);
  const id = proposalId(board.nextProposal++);
  const proposal: MemoryProposal = { ...draft, id, status: "pending" };
  await tx.doc(ProposalDoc, id, proposal);
  board.openProposals.push(id);
  return proposal;
}
