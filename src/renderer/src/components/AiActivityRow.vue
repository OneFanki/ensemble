<script setup lang="ts">
/**
 * One AI activity row, as both the toolbar panel and the console page draw it.
 *
 * The two places show the same record at different densities, so only the
 * variable parts are props: the tool, the count when several calls folded into
 * one row, the time, and whether it was refused. Everything that decides *what*
 * a row means — the warning tone of a refusal, the count only appearing when it
 * is more than one — lives here, so the panel cannot disagree with the page.
 */
import { CircleSlash, Wrench } from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiActivityRecord } from "@shared/types";

const props = defineProps<{
  record: AiActivityRecord;
  /** Compact spacing for the panel; the page keeps the roomier row. */
  dense?: boolean;
}>();

const { t } = useI18n();

/** Refused rows are the only ones that get an icon: the rest are routine. */
const refused = computed(() => !props.record.originAuthorized || !props.record.ok);

const when = computed(() => {
  const at = new Date(props.record.at);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = new Date().toDateString() === at.toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
});

/**
 * The tool name, shown as-is.
 *
 * These are the MCP tool names the AI client used — `click_browser_element`, not
 * "clicked an element". A log's job is to be checkable against what the client
 * says it did, and a translated paraphrase cannot be matched to a call.
 */
const tool = computed(() => props.record.tool);

/**
 * What the call did, in words.
 *
 * Records written before this field existed carry only the tool name; falling
 * back to it keeps an old log readable instead of showing an empty row.
 */
const summary = computed(() => props.record.summary?.trim() || props.record.tool);
</script>

<template>
  <div class="ai-row" :class="{ dense, refused }" :data-ai-record="record.id">
    <component :is="refused ? CircleSlash : Wrench" :size="12" class="ai-row-icon" />
    <!--
      What was done, then which tool did it.

      The tool name alone is the least useful half: "click_browser_element" does
      not say the AI clicked 投放, and a reader scrolling a history is looking
      for the action, not the API. The name stays beside it because a log has to
      be checkable against what the client says it did.
    -->
    <span class="ai-row-copy">
      <span class="ai-row-summary">{{ summary }}</span>
      <span class="ai-row-tool mono">{{ tool }}</span>
    </span>
    <span v-if="record.count > 1" class="ai-row-count mono" :title="t('app.aiActivityRepeat')">
      ×{{ record.count }}
    </span>
    <span v-if="record.approval === 'deny' || record.approval === 'timeout'" class="ai-row-tag">
      {{ record.approval === "timeout" ? t("app.aiActivityTimedOut") : t("app.aiActivityRefused") }}
    </span>
    <span class="ai-row-when mono">{{ when }}</span>
  </div>
</template>

<style scoped>
.ai-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 5px 10px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.ai-row.dense {
  padding: 3px 10px;
}

.ai-row-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

.ai-row.refused .ai-row-icon {
  color: var(--amber);
}

.ai-row-copy {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
}

/* The action carries the row; the tool name is the technical footnote beside it. */
.ai-row-summary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--text);
}

.ai-row-tool {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

/* The count is data, not decoration: it says four clicks were folded into this
   line, which is the difference between one attempt and a loop. */
.ai-row-count {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.ai-row-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--amber) 18%, transparent);
  color: var(--amber);
  font-size: var(--fs-2xs);
}

.ai-row-when {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}
</style>
