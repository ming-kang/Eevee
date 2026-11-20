<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import { errorText } from "../errors.ts";
import { t } from "../i18n.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  client: Client;
  project: string;
  question: QuestionId;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  close: [];
  "open-ticket": [ticketId: string];
}>();

const data = ref<Question>();
const error = ref<string>();
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    data.value = await props.client.call(
      "GET /api/projects/:project/questions/:question",
      { project: props.project, question: props.question },
    );
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}

watch(() => [props.question, props.project], load, { immediate: true });

/** The answer recorded per item: the stored array, else the whole answer for a single-item question. */
function chosen(data: Question, i: number): string | undefined {
  if (data.answers !== undefined) return data.answers[i];
  return data.items.length === 1 ? data.answer : undefined;
}

const status = computed(() => {
  const q = data.value;
  if (q === undefined) return "";
  if (q.answeredAt !== undefined) {
    return t("Answered {time}", { time: formatRelativeTime(q.answeredAt) });
  }
  return t("Withdrawn");
});
</script>

<template>
  <div class="qcard">
    <div class="qcard-h">
      <Icon name="help" size="sm" class="dim" />
      <span>
        <template v-if="data?.ticketId">
          <TicketRef
            :ticket-id="data.ticketId"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          {{ t("asked") }}
        </template>
        <template v-else>{{ t("The Router asked") }}</template>
      </span>
      <span class="spacer" />
      <span v-if="status !== ''" class="qstatus">{{ status }}</span>
      <button
        type="button"
        class="btn ghost sm icon"
        :title="t('Close')"
        :aria-label="t('Close')"
        @click="$emit('close')"
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
    <div v-if="loading" class="qbody"><Skeleton :lines="2" /></div>
    <div v-else-if="error !== undefined" class="qbody">
      <p class="composer-error" role="alert">{{ error }}</p>
      <button type="button" class="btn ghost sm" @click="load">{{ t("Retry") }}</button>
    </div>
    <div v-else-if="data" class="qbody">
      <div v-for="(item, i) in data.items" :key="i" class="qitem">
        <div class="qitem-t">
          <span v-if="data.items.length > 1" class="n">{{ i + 1 }}.</span>
          <span>{{ item.text }}</span>
        </div>
        <div class="opts">
          <div v-if="item.options.length > 0" class="opts-group">
            <button
              v-for="option in item.options"
              :key="option"
              type="button"
              class="opt"
              :class="{ on: chosen(data, i) === option }"
              disabled
            >
              <span class="radio" />
              <span>{{ option }}</span>
              <span v-if="option === item.recommended" class="rec">{{ t("Recommended") }}</span>
            </button>
          </div>
          <p
            v-if="chosen(data, i) !== undefined && !item.options.includes(chosen(data, i) ?? '')"
            class="qcustom"
          >
            {{ chosen(data, i) }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
