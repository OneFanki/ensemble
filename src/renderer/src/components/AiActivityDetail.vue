<script setup lang="ts">
/**
 * What a call actually contained: the script, its redacted arguments, and a
 * bounded result.
 *
 * The activity row is the scan line; this is the thing a reader opens when the
 * line says "executed a script" and they need to know which script. Arguments
 * arrive already redacted from the main process — this component never sees a
 * typed password.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiActivityDetail, AiActivityRecord } from "@shared/types";

const props = defineProps<{ record: AiActivityRecord }>();

const { t } = useI18n();

const details = computed<AiActivityDetail[]>(() => props.record.details ?? []);

function scriptOf(detail: AiActivityDetail): string | undefined {
  const expression = detail.args?.["expression"];
  return typeof expression === "string" && expression.trim() ? expression : undefined;
}

/** Arguments other than the expression, which has its own block. */
function otherArgsOf(detail: AiActivityDetail): string | undefined {
  if (!detail.args) return undefined;
  const rest = Object.fromEntries(
    Object.entries(detail.args).filter(([key]) => key !== "expression"),
  );
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : undefined;
}

function timeOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
</script>

<template>
  <div class="ai-detail" :data-ai-record-detail="record.id">
    <div class="ai-detail-meta">
      <span v-if="record.tabTitle" class="ai-detail-tab">{{ record.tabTitle }}</span>
      <span class="mono">{{ record.origin }}</span>
    </div>

    <div
      v-for="(detail, index) in details"
      :key="`${detail.at}-${index}`"
      class="ai-detail-call"
      data-ai-detail-call
    >
      <span class="ai-detail-at mono">{{ timeOf(detail.at) }}</span>
      <template v-if="scriptOf(detail)">
        <span class="ai-detail-label">{{ t("app.aiActivityDetailScript") }}</span>
        <pre class="ai-detail-pre mono" data-ai-detail-script>{{ scriptOf(detail) }}</pre>
      </template>
      <template v-if="otherArgsOf(detail)">
        <span class="ai-detail-label">{{ t("app.aiActivityDetailArgs") }}</span>
        <pre class="ai-detail-pre mono">{{ otherArgsOf(detail) }}</pre>
      </template>
      <template v-if="detail.result">
        <span class="ai-detail-label">{{ t("app.aiActivityDetailResult") }}</span>
        <pre class="ai-detail-pre mono" data-ai-detail-result>{{ detail.result }}</pre>
      </template>
    </div>

    <p v-if="record.error" class="ai-detail-error">{{ record.error }}</p>
  </div>
</template>

<style scoped>
.ai-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--line-soft);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
}

.ai-detail-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  color: var(--faint);
}

.ai-detail-tab {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.ai-detail-call {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding-top: 4px;
  border-top: 1px dashed var(--line-soft);
}

.ai-detail-call:first-of-type {
  padding-top: 0;
  border-top: 0;
}

.ai-detail-at {
  color: var(--faint);
}

.ai-detail-label {
  color: var(--text-secondary);
}

.ai-detail-pre {
  max-height: 220px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.ai-detail-error {
  margin: 0;
  color: var(--amber);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
