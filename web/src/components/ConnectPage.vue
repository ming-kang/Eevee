<script setup lang="ts">
import { showToast } from "../toasts.ts";
import BrandLogo from "./BrandLogo.vue";
import Icon from "./Icon.vue";

defineProps<{
  reason?: string;
  networkError?: string;
}>();

defineEmits<{
  retry: [];
}>();

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    showToast(`已复制 ${text}`);
  } catch {
    showToast("复制失败，请手动复制", "error");
  }
}
</script>

<template>
  <div class="connect">
    <div class="connect-card">
      <div class="brand" style="font-size: 17px">
        <BrandLogo />
        <span>Eevee</span>
      </div>
      <div>
        <h1>连接到本机的 Engine</h1>
        <p class="muted" style="margin: 6px 0 0; font-size: 13px">
          这个页面需要一次性授权码。直接打开地址时只显示这份说明。
        </p>
      </div>
      <div v-if="networkError" class="banner bad">
        <Icon name="alert" size="sm" />
        <div>无法连接 Engine：{{ networkError }}</div>
      </div>
      <div v-else-if="reason" class="banner info">
        <Icon name="lock" size="sm" />
        <div>{{ reason }}</div>
      </div>
      <ol>
        <li>
          <b style="font-weight: 550">在终端运行</b>
          <div class="codeline">
            <code>eevee web</code>
            <button
              type="button"
              class="btn ghost sm icon"
              title="复制命令"
              aria-label="复制 eevee web"
              @click="copy('eevee web')"
            >
              <Icon name="copy" size="xs" />
            </button>
          </div>
        </li>
        <li>
          <b style="font-weight: 550">浏览器会打开带授权码的地址</b>
          <span class="muted" style="font-size: 12px">
            授权码 90 秒内有效、只能用一次，换成会话后会立刻从地址栏移除。
          </span>
        </li>
        <li>
          <b style="font-weight: 550">Engine 没在运行？</b>
          <span class="muted" style="font-size: 12px">
            先运行 <span class="mono">eevee start</span>，再运行 <span class="mono">eevee web</span>。
          </span>
        </li>
      </ol>
      <div style="display: flex; gap: 8px; align-items: center" class="hint">
        <span class="dot" :class="{ bad: Boolean(networkError) }" />
        <span>{{ networkError ? "连接失败" : "未授权 · 会话 12 小时无操作才过期" }}</span>
        <span class="spacer" />
        <button v-if="networkError" type="button" class="btn sm" @click="$emit('retry')">
          <Icon name="refresh" size="xs" />
          <span>重试</span>
        </button>
      </div>
    </div>
  </div>
</template>
