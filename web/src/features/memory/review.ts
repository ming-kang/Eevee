import { ref } from "vue";
import type { MemoryProposal, ProposalId } from "../../../../src/domain/index.ts";
import type { Client } from "../../../../src/protocol/client.ts";
import type { MemoryProposalView } from "../../../../src/protocol/views.ts";
import { errorText } from "../../lib/errors.ts";

export function createProposalReview(
  client: Client,
  changed: () => Promise<void> = async () => {},
) {
  const proposals = ref<MemoryProposal[]>([]);
  const detail = ref<MemoryProposalView>();
  const loading = ref(false);
  const busy = ref(false);
  const error = ref<string>();
  const reason = ref("");
  let project = "";
  let lists = 0;
  let selections = 0;
  let selected: ProposalId | undefined;

  async function select(id: ProposalId): Promise<void> {
    if (selected !== id) reason.value = "";
    selected = id;
    const token = ++selections,
      target = project;
    detail.value = undefined;
    error.value = undefined;
    try {
      const result = await client.call("GET /api/projects/:project/memory/proposals/:proposal", {
        project: target,
        proposal: id,
      });
      if (token === selections && target === project) detail.value = result;
    } catch (cause) {
      if (token === selections && target === project) error.value = errorText(cause);
    }
  }

  async function load(id: string): Promise<void> {
    const token = ++lists;
    if (id !== project) {
      selections++;
      selected = undefined;
      detail.value = undefined;
      proposals.value = [];
      reason.value = "";
    }
    project = id;
    loading.value = true;
    error.value = undefined;
    try {
      const result = await client.call("GET /api/projects/:project/memory/proposals", {
        project: id,
      });
      if (token !== lists) return;
      proposals.value = result.proposals;
      const next =
        result.proposals.find((p) => p.id === selected) ??
        result.proposals.find((p) => p.status === "pending") ??
        result.proposals[0];
      if (next) await select(next.id);
      else {
        selections++;
        selected = undefined;
        detail.value = undefined;
      }
    } catch (cause) {
      if (token === lists) error.value = errorText(cause);
    } finally {
      if (token === lists) loading.value = false;
    }
  }

  async function decide(action: "approve" | "reject"): Promise<void> {
    const proposal = detail.value,
      target = project;
    if (busy.value || proposal?.status !== "pending") return;
    busy.value = true;
    error.value = undefined;
    let failure: string | undefined;
    try {
      const params = { project: target, proposal: proposal.id };
      if (action === "approve")
        await client.call("POST /api/projects/:project/memory/proposals/:proposal/approve", params);
      else
        await client.call("POST /api/projects/:project/memory/proposals/:proposal/reject", params, {
          ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
        });
      if (target === project) await changed();
    } catch (cause) {
      failure = errorText(cause);
    }
    try {
      if (target === project) {
        await load(target);
        if (failure) error.value = failure;
      }
    } finally {
      busy.value = false;
    }
  }

  return {
    proposals,
    detail,
    loading,
    busy,
    error,
    reason,
    load,
    select,
    approve: () => decide("approve"),
    reject: () => decide("reject"),
  };
}
