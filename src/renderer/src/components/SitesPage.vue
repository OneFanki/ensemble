<script setup lang="ts">
import type { Site, Tag as WorkspaceTag } from "@shared/types";
import { Globe, GripVertical, Pencil, Plus, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useGroupCollapse } from "../composables/useGroupCollapse";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import GroupCollapseAll from "./GroupCollapseAll.vue";
import GroupHeader from "./ui/GroupHeader.vue";
import PageHeader from "./ui/PageHeader.vue";

const emit = defineEmits<{
  newSite: [];
  editSite: [id: string];
  openSite: [id: string];
  /** The card's main action: another account on this system. */
  addIdentity: [siteId: string];
}>();

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const sites = computed(() => store.sites);
const tags = computed(() => store.snapshot?.tags ?? []);

/*
 * Reordering by dragging a card's grip.
 *
 * A group is a view over the global site list (a site with two tags shows up in
 * two groups), so the drop index is the target's index in `sites`, not its index
 * inside the group. Dragging inside one group therefore moves the site globally
 * and every other group follows — the order is one list, not one per tag.
 */
const draggedSiteId = ref<string | null>(null);
const dropSiteId = ref<string | null>(null);

function onSiteDragStart(site: Site, event: DragEvent): void {
  draggedSiteId.value = site.id;
  event.dataTransfer?.setData("text/plain", site.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onSiteDragOver(site: Site, event: DragEvent): void {
  if (!draggedSiteId.value || draggedSiteId.value === site.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropSiteId.value = site.id;
}

function onSiteDragLeave(site: Site): void {
  if (dropSiteId.value === site.id) dropSiteId.value = null;
}

async function onSiteDrop(site: Site): Promise<void> {
  const movingId = draggedSiteId.value;
  onSiteDragEnd();
  if (!movingId || movingId === site.id) return;
  const toIndex = sites.value.findIndex((item) => item.id === site.id);
  if (toIndex >= 0) await store.moveSite(movingId, toIndex);
}

function onSiteDragEnd(): void {
  draggedSiteId.value = null;
  dropSiteId.value = null;
}

/**
 * Sites grouped by tag. A site with several tags appears in each group — the
 * list is a view, not a partition, so nothing is hidden. Untagged sites go to a
 * trailing "no tag" group.
 */
const groups = computed(() => {
  const result: Array<{ key: string; tag?: WorkspaceTag; sites: Site[] }> = [];
  for (const tag of tags.value) {
    const members = sites.value.filter((site) => site.tagIds?.includes(tag.id));
    if (members.length > 0) result.push({ key: tag.id, tag, sites: members });
  }
  const untagged = sites.value.filter((site) => !site.tagIds || site.tagIds.length === 0);
  if (untagged.length > 0) result.push({ key: "__untagged__", sites: untagged });
  return result;
});

const groupCollapse = useGroupCollapse("ensemble.groups.sites");
/** Keys of the groups on screen; the collapse-all switch works on these. */
const groupKeys = computed(() => groups.value.map((group) => group.key));
const allCollapsed = computed(() => groupCollapse.allCollapsed(groupKeys.value));

function identityCount(site: Site): number {
  return store.identities.filter((identity) => identity.siteId === site.id).length;
}

function viewCount(site: Site): number {
  return store.views.filter((view) => view.siteId === site.id).length;
}

function passwordSet(site: Site): boolean {
  return Boolean(store.credentials?.site[site.id]);
}

async function remove(site: Site) {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteSiteConfirm", { name: site.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteSite(site.id);
}

import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
</script>

<template>
  <section class="page sites">
    <PageHeader :title="$t('app.sites')">
      <template #actions>
        <GroupCollapseAll
          v-if="groups.length > 1"
          :all-collapsed="allCollapsed"
          @toggle="groupCollapse.toggleAll(groupKeys)"
        />
        <AppButton variant="primary" @click="emit('newSite')">
          <Plus :size="13" />
          {{ $t("app.newSite") }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="page-body">
      <div v-if="!sites.length" class="empty">
        <Globe :size="22" />
        <p>{{ $t("app.emptySites") }}</p>
        <div class="empty-actions">
          <AppButton variant="primary" @click="emit('newSite')">
            <Plus :size="13" />
            {{ $t("app.newSite") }}
          </AppButton>
        </div>
      </div>

      <div v-else class="group-list">
        <!--
          Group headers are the fold control. The whole row is clickable rather
          than only the arrow: a 16px arrow is a small target, and the header is
          the line the eye is already on when it wants "hide this section".
        -->
        <section v-for="group in groups" :key="group.key" class="group">
          <GroupHeader
            :name="group.tag?.name ?? t('app.untaggedSites')"
            :count="group.sites.length"
            :collapsed="groupCollapse.isCollapsed(group.key)"
            :color="group.tag?.color"
            @toggle="groupCollapse.toggle(group.key)"
          />

          <div v-if="!groupCollapse.isCollapsed(group.key)" class="env-grid">
            <article
              v-for="site in group.sites"
              :key="site.id"
              class="env-card"
              :class="{ dragging: draggedSiteId === site.id, drop: dropSiteId === site.id }"
              @dragover="onSiteDragOver(site, $event)"
              @dragleave="onSiteDragLeave(site)"
              @drop.prevent="onSiteDrop(site)"
            >
              <div class="card-head">
                <span
                  class="site-grip"
                  draggable="true"
                  :title="$t('app.dragReorder')"
                  :aria-label="$t('app.dragReorder')"
                  @dragstart="onSiteDragStart(site, $event)"
                  @dragend="onSiteDragEnd"
                >
                  <GripVertical :size="12" />
                </span>
                <h2 class="env-name">{{ site.name }}</h2>
                <span class="card-actions">
                  <IconButton :ariaLabel="$t('app.edit')" @click="emit('editSite', site.id)">
                    <Pencil :size="12" />
                  </IconButton>
                  <IconButton variant="danger" :ariaLabel="$t('app.delete')" @click="remove(site)">
                    <Trash2 :size="12" />
                  </IconButton>
                </span>
              </div>

              <p class="env-url mono" :title="site.baseUrl">
                <Globe :size="11" />
                <span>{{ site.baseUrl }}</span>
              </p>

              <!--
                Facts as chips, the way the mockup draws them: each is a distinct
                little statement, and separated by dots in running text they
                collapsed into one grey line ("2 身份 1 视图 未设置" reads as a
                sentence). The chip frame also gives "no password" somewhere to
                be an accent without colouring three words mid-line.
              -->
              <div class="env-meta">
                <span class="env-chip">
                  <b class="mono">{{ identityCount(site) }}</b> {{ $t("app.identities") }}
                </span>
                <span class="env-chip">
                  <b class="mono">{{ viewCount(site) }}</b> {{ $t("app.views") }}
                </span>
                <span class="env-chip" :class="{ missing: !passwordSet(site) }">
                  {{ passwordSet(site) ? $t("app.passwordSet") : $t("app.passwordNotSet") }}
                </span>
              </div>

              <!--
                The card's main action is another account on this system.
                "Open the site" used to be here as the primary button, which made
                a site look like a place to visit — the same kind of thing as a
                bookmark. It is not: a site is a login recipe and the header of a
                group of accounts, and the thing people do with it is add one
                more. Opening still exists, as the quiet button beside it.
              -->
              <div class="card-foot">
                <AppButton size="sm" variant="primary" :title="$t('app.newIdentityHere')"
                  @click="emit('addIdentity', site.id)">
                  <Plus :size="12" />
                  {{ $t("app.newIdentity") }}
                </AppButton>
                <AppButton size="sm" :title="$t('app.openSiteHint')"
                  @click="store.markSiteUsed(site.id); emit('openSite', site.id)">
                  <Globe :size="12" />
                  {{ $t("app.openSite") }}
                </AppButton>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.env-grid {
  margin-top: 10px;
  display: grid;
  /* The mockup's grid: `repeat(auto-fill, minmax(212px, 1fr))` with a 10px gap.
     A wide minimum (300–460px) fitted two fat cards on a 1240px pane and left
     most of the page empty; a site card holds a name, an address and three
     facts, which is exactly what 212px is for. */
  grid-template-columns: repeat(auto-fill, minmax(212px, 1fr));
  /* Rows size to their card, never to leftover container height: the cards clip
     their own overflow, so a compressed row silently eats their footer. */
  grid-auto-rows: min-content;
  gap: 10px;
  align-content: start;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.env-card {
  /* A hairline that actually reads. With the card and the page both at
     `--surface`, `--line-soft` sat at 1.15:1 against it — visible on a large
     dark screenshot, invisible on a white page at 100%. The stronger step keeps
     the flat look and still states the card's edge. */
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  /* No internal rules: the card is one thought (name, address, three facts,
     open), and a rule between each of those four made a 300px box look like a
     small form. */
  padding: 12px 13px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.env-card:hover {
  border-color: color-mix(in srgb, var(--line) 55%, var(--muted));
}

.env-card.active {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 4%, var(--surface));
}

/* Drag handle: cards carry buttons, so only the grip starts a drag. */
.site-grip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--faint);
  cursor: grab;
}

.site-grip:active {
  cursor: grabbing;
}

.env-card.dragging {
  opacity: 0.5;
}

/* Insertion line at the top of the card the drag would land on. */
.env-card.drop {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: inset 0 2px 0 var(--accent);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.env-name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.active-chip {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--accent-text);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
  border-radius: 999px;
  padding: 2px 7px 2px 5px;
  flex: 0 0 auto;
}

.env-url {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--faint);
  min-width: 0;
}

.env-url span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* The mockup draws facts as 19px chips on the field colour. */
.env-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 19px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  background: var(--field);
  color: var(--muted);
  font-size: var(--fs-2xs);
  white-space: nowrap;
}

.env-chip b {
  font-weight: 500;
  color: var(--text-secondary);
}

/* "No default password" is the one fact here that needs attention. */
.env-chip.missing {
  color: color-mix(in srgb, var(--accent) 82%, var(--text));
  background: var(--accent-soft);
}

/* Pushed to the card's bottom edge without a rule above it: the card's own
   border already separates it from the next one. */
.card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
}

.card-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.icon-btn + .icon-btn {
  margin-left: 0;
}

.btn.small {
  padding: 5px 10px;
}
</style>
