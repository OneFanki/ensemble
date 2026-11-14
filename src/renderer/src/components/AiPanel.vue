<script setup lang="ts">
/**
 * The AI panel: what the endpoint is doing, what it may do here, and what it has
 * been doing.
 *
 * Three jobs in one popover because they are one question — "is the assistant
 * working, and what is it allowed to touch". The entry used to be a row in the
 * app menu, which made the endpoint's state something you had to open a menu to
 * see, and the permission was a separate shield button whose on/off state could
 * only say half of what four policies mean. Both came back here: the toolbar
 * icon states whether the endpoint is listening, and the panel carries the
 * per-site decision and the newest records.
 *
 * The records are grouped by site because that is the question a log gets asked.
 * A flat list of sixteen rows from three sites is one list nobody can skim; two
 * site headings with their own rows is what "what did it do on *that* site"
 * needs.
 */
import { ChevronsDown, ChevronsUp, Settings2, Sparkles, ShieldCheck, ShieldOff } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { aiGateState } from "@shared/ai-policy";
import { groupAiActivity } from "@shared/ai-activity";
import type { AiActivitySiteGroup } from "@shared/types";
import { useWorkspaceStore } from "../stores/workspace";
import AiActivityRow from "./AiActivityRow.vue";
import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
import LinkButton from "./ui/LinkButton.vue";

const props = defineProps<{
  /** Origin of the page in front, when that page is gated at all. */
  origin?: string;
  /** True while the panel is open, so the record list can re-read. */
  open: boolean;
}>();

const emit = defineEmits<{ close: []; openConsole: []; openSettings: [] }>();

const workspace = useWorkspaceStore();
const { t } = useI18n();

/** How many sites and rows the panel shows before sending the reader to the page. */
const RECENT_SITES = 2;
const RECENT_ROWS = 3;

const expanded = ref<Record<string, boolean>>({});

const running = computed(() => Boolean(workspace.mcp?.running));
const starting = computed(() => Boolean(workspace.mcp?.starting));
const endpointError = computed(() => workspace.mcp?.error ?? "");

const statusLabel = computed(() => {
  if (starting.value) return t("app.aiEndpointStarting");
  if (running.value) return t("app.aiEndpointRunning");
  if (endpointError.value) return t("app.aiEndpointError");
  return t("app.aiEndpointOff");
});

const statusTone = computed(() => {
  if (starting.value) return "pending";
  if (running.value) return "on";
  return endpointError.value ? "error" : "off";
});

/**
 * The permission for the page in front, worked out by the same function the
 * tool gate uses.
 *
 * Rebuilding that decision here out of `aiMode` and `aiOrigins` is what the old
 * shield button did, and it was already one edit away from claiming a permission
 * the server would refuse.
 */
const gate = computed(() => {
  if (!props.origin) return undefined;
  return aiGateState(
    { origin: props.origin },
    {
      dailyMode: workspace.mcp?.aiMode ?? "allowlist",
      listedOrigins: [
        ...(workspace.mcp?.aiOrigins ?? []),
        ...(workspace.mcp?.aiSessionOrigins ?? []),
      ],
      knownUrls: [],
    },
  );
});

/** Whether the stored list — not the effective one — holds this origin. */
const listed = computed(() => Boolean(props.origin && workspace.mcp?.aiOrigins.includes(props.origin)));
const grantedForSession = computed(() =>
  Boolean(props.origin && workspace.mcp?.aiSessionOrigins.includes(props.origin)),
);

const mode = computed(() => workspace.mcp?.aiMode ?? "allowlist");
/** The two modes where a per-origin switch means something. */
const listMode = computed(() => mode.value === "allowlist" || mode.value === "denylist");

const gateSentence = computed(() => {
  switch (gate.value) {
    case "open":
      return grantedForSession.value
        ? t("app.aiOriginOpenSessionHint")
        : t("app.aiOriginOpenHint");
    case "blocked":
      return t("app.aiOriginBlockedHint");
    case "unlisted":
      return t("app.aiOriginUnlistedHint");
    default:
      return "";
  }
});

const recentGroups = computed<AiActivitySiteGroup[]>(() =>
  groupAiActivity(workspace.aiActivity).slice(0, RECENT_SITES),
);

function siteNameOf(group: AiActivitySiteGroup): string {
  const site = group.siteId
    ? workspace.sites.find((item) => item.id === group.siteId)
    : undefined;
  return site?.name ?? group.origin;
}

function isExpanded(group: AiActivitySiteGroup): boolean {
  return expanded.value[group.key] !== false;
}

function toggleGroup(group: AiActivitySiteGroup): void {
  expanded.value = { ...expanded.value, [group.key]: !isExpanded(group) };
}

const allCollapsed = computed(() =>
  recentGroups.value.length > 0 && recentGroups.value.every((group) => !isExpanded(group)),
);

function toggleAll(): void {
  const next = !allCollapsed.value;
  expanded.value = Object.fromEntries(recentGroups.value.map((group) => [group.key, !next]));
}

/**
 * Adds or removes the origin from the stored list.
 *
 * A session grant is dropped at the same time: otherwise the button would say
 * "撤销" and the page would stay allowed until the app restarted, because the
 * grant kept the origin usable behind the list's back.
 */
async function toggleOrigin(): Promise<void> {
  if (!props.origin) return;
  const next = !listed.value;
  const status = await workspace.updateMcp({ aiOrigin: { origin: props.origin, allowed: next } });
  if (!status) return;
  workspace.notify(
    t(next ? "app.aiOriginGranted" : "app.aiOriginRevoked", { origin: props.origin }),
    "success",
  );
}

async function enableEndpoint(): Promise<void> {
  await workspace.updateMcp({ enabled: true });
}

watch(
  () => props.open,
  (open) => {
    if (open) void workspace.refreshAiActivity();
  },
);
</script>

<template>
  <div class="ai-panel" data-ai-panel-body role="dialog" :aria-label="t('app.mcpAiAccess')">
    <div class="ai-head">
      <span class="ai-head-title">
        <Sparkles :size="13" />
        {{ t("app.mcpAiAccess") }}
      </span>
      <span class="ai-head-status" :class="statusTone">{{ statusLabel }}</span>
      <IconButton
        :ariaLabel="t('app.mcpSettings')"
        data-ai-open-settings
        @click="emit('openSettings')"
      >
        <Settings2 :size="13" />
      </IconButton>
    </div>

    <!-- Off: the panel's first job is to say so and offer the switch. -->
    <div v-if="!running" class="ai-off">
      <p class="ai-off-text">{{ t("app.aiPanelOffHint") }}</p>
      <AppButton size="sm" variant="primary" data-ai-enable @click="enableEndpoint">
        {{ t("app.aiEnable") }}
      </AppButton>
    </div>

    <div v-if="origin && listMode" class="ai-gate" data-ai-gate>
      <div class="ai-gate-copy">
        <span class="ai-gate-origin mono">{{ origin }}</span>
        <span class="ai-gate-sentence">{{ gateSentence }}</span>
      </div>
      <AppButton
        size="sm"
        :variant="listed ? 'ghost' : 'default'"
        :data-ai-allow-origin="origin"
        :aria-pressed="listed"
        @click="toggleOrigin"
      >
        <component :is="listed ? ShieldOff : ShieldCheck" :size="12" />
        {{ listed ? t("app.aiOriginRevoke") : t("app.aiOriginAllow") }}
      </AppButton>
    </div>
    <!-- The two whole-profile modes ignore the list, so a switch here would lie. -->
    <div v-else-if="origin" class="ai-gate" data-ai-gate>
      <div class="ai-gate-copy">
        <span class="ai-gate-origin mono">{{ origin }}</span>
        <span class="ai-gate-sentence">{{ gateSentence }}</span>
      </div>
    </div>

    <div class="ai-records">
      <div class="ai-records-head">
        <span>{{ t("app.aiActivityTitle") }}</span>
        <IconButton
          v-if="recentGroups.length"
          :ariaLabel="allCollapsed ? t('app.expandAll') : t('app.collapseAll')"
          @click="toggleAll"
        >
          <component :is="allCollapsed ? ChevronsDown : ChevronsUp" :size="12" />
        </IconButton>
      </div>
      <p v-if="!recentGroups.length" class="ai-records-empty">{{ t("app.aiActivityEmpty") }}</p>
      <template v-else>
        <div v-for="group in recentGroups" :key="group.key" class="ai-group">
          <button
            type="button"
            class="ai-group-head"
            :aria-expanded="isExpanded(group)"
            :data-ai-group="group.key"
            @click="toggleGroup(group)"
          >
            <span class="ai-group-name">{{ siteNameOf(group) }}</span>
            <span class="ai-group-count mono">{{ group.records.length }}</span>
          </button>
          <div v-if="isExpanded(group)" class="ai-group-rows">
            <AiActivityRow
              v-for="record in group.records.slice(0, RECENT_ROWS)"
              :key="record.id"
              :record="record"
              dense
            />
          </div>
        </div>
      </template>
      <LinkButton class="ai-foot" data-ai-open-console @click="emit('openConsole')">
        {{ t("app.aiActivityOpenAll") }}
      </LinkButton>
    </div>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  max-height: 460px;
  overflow: hidden;
}

.ai-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

.ai-head-title {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.ai-head-status {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
}

.ai-head-status.on {
  color: var(--green);
}

.ai-head-status.pending {
  color: var(--amber);
}

.ai-head-status.error {
  color: var(--red, #d9534f);
}

.ai-head-status.off {
  color: var(--faint);
}

.ai-off {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 10px;
  border-bottom: 1px solid var(--line-soft);
}

.ai-off-text {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.ai-gate {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
}

.ai-gate-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.ai-gate-origin {
  font-size: var(--fs-2xs);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-gate-sentence {
  font-size: var(--fs-2xs);
  color: var(--faint);
  line-height: 1.45;
}

.ai-records {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.ai-records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px 4px 10px;
  font-size: var(--fs-2xs);
  color: var(--faint);
  flex: 0 0 auto;
}

.ai-records-empty {
  margin: 0;
  padding: 6px 10px 10px;
  font-size: var(--fs-sm);
  color: var(--faint);
}

.ai-group {
  display: flex;
  flex-direction: column;
}

.ai-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 4px 10px;
  border: 0;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  text-align: left;
  cursor: pointer;
}

.ai-group-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-group-count {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.ai-group-rows {
  display: flex;
  flex-direction: column;
}

.ai-foot {
  align-self: flex-start;
  margin: 2px 0 8px;
  padding-inline: 10px;
  font-size: var(--fs-2xs);
}
</style>
