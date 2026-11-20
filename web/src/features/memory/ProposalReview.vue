<script setup lang="ts">
import { computed, ref } from "vue";
import type { MemoryProposal } from "@shared/domain/index.ts";
import { t } from "../../lib/i18n.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import Button from "../../ui/Button.vue";
import { fieldClass } from "../../ui/field.ts";
import { ERROR_TEXT, PANEL } from "../../ui/surface.ts";
import FileDiffs from "./FileDiffs.vue";
import type { createProposalReview } from "./review.ts";

const props = defineProps<{ review: ReturnType<typeof createProposalReview> }>();
const mobileDetail = ref(false);
async function select(id: MemoryProposal["id"]): Promise<void> {
  mobileDetail.value = true;
  await props.review.select(id);
}
const pending = computed(() => props.review.proposals.value.filter(p => p.status === "pending"));
const decided = computed(() => props.review.proposals.value.filter(p => p.status !== "pending"));
const labels: Record<MemoryProposal["status"], string> = {
  pending: t("Pending approval"), approved: t("Approved"), rejected: t("Rejected"), stale: t("Stale"),
};
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-(--ev-gutter)">
    <p v-if="review.error.value" role="alert" :class="ERROR_TEXT">{{ review.error.value }}</p>
    <p v-if="review.loading.value" class="text-sm text-fg-muted">{{ t("Loading…") }}</p>
    <div class="grid items-start gap-5 @min-[900px]/vp:grid-cols-[minmax(220px,1fr)_minmax(0,3fr)]">
      <aside class="flex flex-col gap-3" :class="{ '@max-[899px]/vp:hidden': mobileDetail }">
        <section v-for="group in [{ title: t('Pending approval'), proposals: pending }, { title: t('Decided proposals'), proposals: decided }]" :key="group.title">
          <h2 class="mb-2 text-sm font-semibold">{{ group.title }} · {{ group.proposals.length }}</h2>
          <p v-if="group.proposals.length === 0" class="text-sm text-fg-muted">{{ t("No memory proposals") }}</p>
          <button v-for="proposal in group.proposals" :key="proposal.id" type="button" class="mb-1 flex w-full flex-col gap-1 rounded-sm border border-border px-3 py-2 text-left text-sm hover:bg-hover" :class="{ 'bg-selected': review.detail.value?.id === proposal.id }" :disabled="review.busy.value" @click="select(proposal.id)">
            <span>{{ proposal.id }} · {{ proposal.scope === "global" ? t("Global") : t("Project") }} · {{ labels[proposal.status] }}</span>
            <span class="break-words">{{ proposal.summary }}</span>
            <span class="text-xs text-fg-muted">{{ proposal.source.kind === "dreaming" ? t("Dreaming") : t("Router") }} {{ proposal.source.ticketId }} · {{ formatRelativeTime(proposal.createdAt) }}</span>
          </button>
        </section>
      </aside>
      <article v-if="review.detail.value" class="min-w-0" :class="{ '@max-[899px]/vp:hidden': !mobileDetail }">
        <Button v-if="mobileDetail" class="mb-3 @min-[900px]/vp:hidden" @click="mobileDetail = false">{{ t("Back") }}</Button>
        <header class="mb-4 flex flex-col gap-2">
          <h2 class="break-words text-sm font-semibold">{{ review.detail.value.id }} · {{ review.detail.value.summary }}</h2>
          <p class="text-xs text-fg-muted">{{ labels[review.detail.value.status] }} <template v-if="review.detail.value.decidedAt">· {{ formatRelativeTime(review.detail.value.decidedAt) }}</template></p>
          <p v-if="review.decisionReason.value && review.decisionReason.value !== review.error.value" class="whitespace-pre-wrap text-sm">{{ review.decisionReason.value }}</p>
          <p v-if="review.previewConflict.value" :class="ERROR_TEXT">{{ review.previewConflict.value }}</p>
          <div v-if="review.detail.value.status === 'pending'" class="flex flex-wrap items-end gap-2">
            <label class="min-w-48 flex-1 text-xs text-fg-muted">{{ t("Reason (optional)") }}
              <textarea v-model="review.reason.value" :class="fieldClass({ multiline: true })" :disabled="review.busy.value" rows="2" />
            </label>
            <Button :disabled="review.busy.value" @click="review.approve()">{{ t("Approve") }}</Button>
            <Button :disabled="review.busy.value" @click="review.reject()">{{ t("Reject") }}</Button>
          </div>
        </header>
        <FileDiffs v-if="review.detail.value.files.length" :diffs="review.detail.value.files" />
        <p v-else :class="PANEL" class="p-4 text-sm text-fg-muted">{{ t("No preview available") }}</p>
      </article>
    </div>
  </div>
</template>
