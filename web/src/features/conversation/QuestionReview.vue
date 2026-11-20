<script setup lang="ts">
import { ApiRequestError, type Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import Icon from "../../ui/Icon.vue";
import Skeleton from "../../ui/Skeleton.vue";
import TicketRef from "../project/TicketRef.vue";
import Button from "../../ui/Button.vue";
import { QCARD, Q_BODY, Q_CUSTOM, Q_HEAD, Q_ITEM, Q_ITEM_T, Q_OPTS, Q_STATUS, RADIO, REC, qOption } from "./question.ts";
import { ERROR_TEXT } from "../../ui/surface.ts";

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
const missing = ref(false);
let loadVersion = 0;

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = undefined;
  data.value = undefined;
  missing.value = false;
  try {
    const question = await props.client.call(
      "GET /api/projects/:project/questions/:question",
      { project: props.project, question: props.question },
    );
    if (version === loadVersion) data.value = question;
  } catch (cause) {
    if (version !== loadVersion) return;
    if (cause instanceof ApiRequestError && cause.status === 404) {
      missing.value = true;
      return;
    }
    error.value = errorText(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
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
  <div :class="QCARD">
    <div :class="Q_HEAD">
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
      <span v-if="status !== ''" :class="Q_STATUS">{{ status }}</span>
      <Button variant="ghost" size="sm" icon :title="t('Close')" :aria-label="t('Close')" @click="$emit('close')">
        <Icon name="x" size="sm" />
      </Button>
    </div>
    <div v-if="loading" :class="Q_BODY"><Skeleton :lines="2" /></div>
    <div v-else-if="missing" :class="Q_BODY">
      <p class="dim" role="status">{{ t("This question is no longer available.") }}</p>
      <Button variant="ghost" size="sm" @click="$emit('close')">{{ t("Back to conversation") }}</Button>
    </div>
    <div v-else-if="error !== undefined" :class="Q_BODY">
      <p :class="ERROR_TEXT" role="alert">{{ error }}</p>
      <Button variant="ghost" size="sm" @click="load">{{ t("Retry") }}</Button>
    </div>
    <div v-else-if="data" :class="Q_BODY">
      <div v-for="(item, i) in data.items" :key="i" :class="Q_ITEM">
        <div :class="Q_ITEM_T">
          <span v-if="data.items.length > 1" class="n">{{ i + 1 }}.</span>
          <span>{{ item.text }}</span>
        </div>
        <div :class="Q_OPTS">
          <div v-if="item.options.length > 0" :class="Q_OPTS">
            <button
              v-for="option in item.options"
              :key="option"
              type="button"
              :class="qOption(chosen(data, i) === option)"
              disabled
            >
              <span :class="RADIO" />
              <span>{{ option }}</span>
              <span v-if="option === item.recommended" :class="REC">{{ t("Recommended") }}</span>
            </button>
          </div>
          <p
            v-if="chosen(data, i) !== undefined && !item.options.includes(chosen(data, i) ?? '')"
            :class="Q_CUSTOM"
          >
            {{ chosen(data, i) }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
