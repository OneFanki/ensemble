<script setup lang="ts">
/**
 * The whole AI activity log, grouped by site.
 *
 * The panel shows the newest two sites because that is what "what is it doing"
 * needs. This page is where you go when the question is historical — "what did
 * it touch on that site last week" — so it lists every site with every record,
 * and it is the only place with a clear action.
 *
 * Same rows as the panel, from the same component: a page that drew its own
 * would be the second opinion about what a refused call looks like.
 */
import { Sparkles } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { groupAiActivity } from "@shared/ai-activity";
import type { AiActivitySiteGroup } from "@shared/types";
import AiActivityRow from "./AiActivityRow.vue";
import GroupCollapseAll from "./GroupCollapseAll.vue";
import GroupHeader from "./ui/GroupHeader.vue";
import PageHeader from "./ui/PageHeader.vue";
import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";

const workspace = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const collapsed = ref<Record<string, boolean>>({});
const groups = computed<AiActivitySiteGroup[]>(() => groupAiActivity(workspace.aiActivity));

const allCollapsed = computed(
  () => groups.value.length > 0 && groups.value.every((group) => collapsed.value[group.key]),
);

/**
 * Re-read on every visit: the panel and this page can be open in different
 * states, and a record written while the browser was on screen should be here
 * when the user comes looking.
 */
onMounted(() => void workspace.refreshAiActivity());

function siteNameOf(group: AiActivitySiteGroup): string {
  const site = group.siteId ? workspace.sites.find((item) => item.id === group.siteId) : undefined;
  return site?.name ?? group.origin;
}

/**
 * Which profile or account a group's pages belonged to.
 *
 * Read from the records rather than joined from the workspace: the record is
 * what the AI actually touched, and a page that has since been signed into a
 * different profile should not rewrite history.
 */
function contextOf(group: AiActivitySiteGroup): string {
  const first = group.records.find((record) => record.identityId || record.clean || record.profileId);
  if (!first) return "";
  if (first.identityId) {
    const identity = workspace.identities.find((item) => item.id === first.identityId);
    return identity?.name ?? t("app.aiActivityContextIdentity");
  }
  if (first.clean) return t("app.aiActivityContextClean");
  const profile = workspace.settings.profiles.find((item) => item.id === first.profileId);
  return profile?.name ?? t("app.aiActivityContextProfile");
}

function toggle(group: AiActivitySiteGroup): void {
  collapsed.value = { ...collapsed.value, [group.key]: !collapsed.value[group.key] };
}

function toggleAll(): void {
  const next = !allCollapsed.value;
  collapsed.value = Object.fromEntries(groups.value.map((group) => [group.key, next]));
}

async function clearAll(): Promise<void> {
  const ok = await confirm.ask({
    title: t("app.aiActivityClear"),
    body: t("app.aiActivityClearBody"),
  });
  if (ok) await workspace.clearAiActivity();
}
</script>

<template>
  <section class="page">
    <PageHeader :title="$t('app.aiActivityTitle')" :note="$t('app.aiActivityNote')" numeric>
      <template #actions>
        <GroupCollapseAll
          v-if="groups.length"
          :all-collapsed="allCollapsed"
          @toggle="toggleAll"
        />
        <AppButton size="sm" :disabled="groups.length === 0" data-ai-activity-clear @click="clearAll">
          {{ $t("app.aiActivityClear") }}
        </AppButton>
      </template>
    </PageHeader>

    <EmptyState v-if="groups.length === 0" :text="$t('app.aiActivityEmpty')">
      <template #icon><Sparkles :size="20" /></template>
    </EmptyState>

    <div v-else class="groups">
      <section v-for="group in groups" :key="group.key" class="group" :data-ai-activity-group="group.key">
        <GroupHeader
          :name="siteNameOf(group)"
          :count="group.records.length"
          :collapsed="Boolean(collapsed[group.key])"
          @toggle="toggle(group)"
        >
          <template #meta>
            <span v-if="contextOf(group)" class="group-context">{{ contextOf(group) }}</span>
            <!-- The address is the group's name when the workspace has no site for
                 it; printing it twice was how a row read "127.0.0.1:52228 默认档案
                 127.0.0.1:52228". -->
            <span v-if="siteNameOf(group) !== group.origin" class="group-origin mono">
              {{ group.origin }}
            </span>
          </template>
        </GroupHeader>
        <div v-if="!collapsed[group.key]" class="rows">
          <AiActivityRow v-for="record in group.records" :key="record.id" :record="record" />
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-context {
  font-size: var(--fs-2xs);
  color: var(--text-secondary);
}

.group-origin {
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}
</style>
