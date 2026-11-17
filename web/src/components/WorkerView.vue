<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import { computed, ref } from "vue";
import { STAGE_LABEL } from "../labels.ts";
import { usePolling } from "../polling.ts";
import { useSubmit } from "../submit.ts";
import ChatView from "./ChatView.vue";
import Composer from "./Composer.vue";

const props = defineProps<{ client: Client; project: string; view: TicketView | undefined; ticketId: string }>();
defineEmits<{ close: [] }>();

const params = computed(() => ({ project: props.project, ticket: props.ticketId }));
const conversation = usePolling(() =>
  props.client.call("GET /api/projects/:project/tickets/:ticket/conversation", params.value),
);
const mode = ref<"steer" | "followUp">("steer");
const open = computed(() => props.view?.ticket.status === "open");
const interrupting = useSubmit();

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/messages", params.value, {
    text,
    mode: mode.value,
  });
  await conversation.refresh();
}

async function interrupt(): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/interrupt", params.value);
  await conversation.refresh();
}

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/retry", params.value);
  await conversation.refresh();
}
</script>

<template>
  <section class="worker">
    <header class="header">
      <button type="button" @click="$emit('close')">← Router</button>
      <strong>{{ ticketId }} {{ view?.ticket.title }}</strong>
      <span v-if="view" class="muted">{{ STAGE_LABEL[view.stage] }}</span>
      <span class="spacer" />
      <button
        v-if="open && conversation.data.value?.running"
        type="button"
        :disabled="interrupting.busy.value"
        @click="interrupting.run(interrupt)"
      >
        打断
      </button>
    </header>
    <ChatView
      :lines="conversation.data.value?.lines ?? []"
      :running="conversation.data.value?.running ?? false"
      :failure="conversation.data.value?.failure"
      :retry="open ? retry : undefined"
      assistant="Worker"
      empty="执行对话还没有开始。"
    />
    <p v-if="conversation.error.value || interrupting.error.value" class="error status">
      {{ conversation.error.value ?? interrupting.error.value }}
    </p>
    <div class="dock">
      <Composer v-if="open" :send="send" placeholder="直接给这个 Worker 发消息…">
        <label class="mode muted">
          <input v-model="mode" type="radio" value="steer" />
          引导（本批工具结束后立刻看到）
        </label>
        <label class="mode muted">
          <input v-model="mode" type="radio" value="followUp" />
          排队（本轮结束后再处理）
        </label>
      </Composer>
      <p v-else class="muted">工单已{{ view?.ticket.status === "done" ? "结单" : "取消" }}。</p>
    </div>
  </section>
</template>

<style scoped>
.worker {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.header {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 24px;
  border-bottom: 1px solid var(--ev-border);
}

.spacer {
  flex: 1;
}

.status {
  padding: 0 24px;
}

.dock {
  padding: 12px 24px 20px;
}

.mode {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
}
</style>
