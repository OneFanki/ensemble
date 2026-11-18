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

/**
 * Opens the site's login page in an external browser.
 *
 * A site with no account named is exactly the throwaway case: `launchCleanSession`
 * takes a site id and starts on its login page in a browser window that forgets
 * everything on close. That is the right answer for a login recipe — the site
 * defines where to go, and no account defines whose session it would be.
 */
async function openSiteExternal(site: Site, engineId: string): Promise<void> {
  store.markSiteUsed(site.id);
  await store.launchCleanSession(site.id, engineId);
}

import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import IconButton from "./ui/IconButton.vue";
import LaunchSplitButton from "./ui/LaunchSplitButton.vue";
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
        <!-- Carried by the empty state below while there is nothing to list, so
             the action sits with the sentence that explains it. -->
        <AppButton v-if="sites.length" variant="primary" @click="emit('newSite')">
          <Plus :size="13" />
          {{ $t("app.newSite") }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="page-body">
      <EmptyState v-if="!sites.length" :text="$t('app.emptySites')">
        <template #icon><Globe :size="22" /></template>
        <AppButton variant="primary" @click="emit('newSite')">
          <Plus :size="13" />
          {{ $t("app.newSite") }}
        </AppButton>
      </EmptyState>

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

          <div
            v-if="!groupCollapse.isCollapsed(group.key)"
            class="env-grid"
          >
            <!-- One header per group: the columns are per group because a group
                 is the local table. A single header pinned above the page would
                 sit apart from every group but the first. -->
            <div class="env-table-head" aria-hidden="true">
              <span></span>
              <span>{{ $t("app.site") }}</span>
              <span>{{ $t("app.columnAddress") }}</span>
              <span>{{ $t("app.columnAccountsViews") }}</span>
              <span class="table-head-actions">{{ $t("app.columnActions") }}</span>
            </div>

            <article
              v-for="site in group.sites"
              :key="site.id"
              class="env-card"
              :class="{ dragging: draggedSiteId === site.id, drop: dropSiteId === site.id }"
              @dragover="onSiteDragOver(site, $event)"
              @dragleave="onSiteDragLeave(site)"
              @drop.prevent="onSiteDrop(site)"
            >
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
                <span class="env-chip" :class="{ missing: !passwordSet(site) }">
                  {{ passwordSet(site) ? $t("app.passwordSet") : $t("app.passwordNotSet") }}
                </span>
              </div>

              <!--
                The row's main action is another account on this system.
                "Open the site" used to be here as the primary button, which made
                a site look like a place to visit — the same kind of thing as a
                bookmark. It is not: a site is a login recipe and the header of a
                group of accounts, and the thing people do with it is add one
                more.

                Opening is a launch, so it uses the same split control as every
                other launch point: the main half opens the login page in the
                built-in surface, the arrow offers an external browser.

                Every control is an icon button, and the accounts page's rows work
                the same way: the "add" action is the same `Plus` its group header
                uses, so the two pages teach each other. A worded button here made
                one row carry a label, a split control and two glyphs — three
                widths and two type sizes in the one column that has to scan.
              -->
              <div class="card-actions">
                <span class="card-main">
                  <IconButton
                    :ariaLabel="$t('app.newIdentityHere')"
                    :data-add-identity="site.id"
                    @click="emit('addIdentity', site.id)"
                  >
                    <Plus :size="13" />
                  </IconButton>
                  <LaunchSplitButton
                    compact
                    :aria-label="$t('app.openSiteHint')"
                    :data-hook="`site-${site.id}`"
                    @launch="store.markSiteUsed(site.id); emit('openSite', site.id)"
                    @launch-external="openSiteExternal(site, $event)"
                  />
                </span>
                <span class="card-manage">
                  <IconButton :ariaLabel="$t('app.edit')" @click="emit('editSite', site.id)">
                    <Pencil :size="12" />
                  </IconButton>
                  <IconButton variant="danger" :ariaLabel="$t('app.delete')" @click="remove(site)">
                    <Trash2 :size="12" />
                  </IconButton>
                </span>
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
  /* One template for the header row and every site row, so a column stays a
     column across rows. All of them are flex tracks rather than `auto`,
     otherwise one long address would widen the address column of only its own
     row. The actions column fits four 24px targets and the split control's
     arrow; a worded button here used to force 190px. */
  --site-cols: 14px minmax(0, 0.9fr) minmax(0, 1.3fr) minmax(0, 1fr) 150px;
  margin-top: 10px;
  min-width: 0;
  /* Rows are joined into one block: the header is the top cap and each row keeps
     only its side and bottom rules. */
  display: flex;
  flex-direction: column;
}

.env-table-head {
  display: grid;
  grid-template-columns: var(--site-cols);
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10px;
  letter-spacing: 0.04em;
  min-width: 0;
}

.table-head-actions {
  justify-self: end;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/*
 * The group label above a table's cap.
 *
 * Without this the two hairlines sat on top of each other: the group header owns
 * a bottom border (it is the whole separator when the group is folded), and the
 * table's cap is a full border a few pixels below it. Two rules that close look
 * like one doubled line, so the group and its table read as a single glued block.
 * Above a table the cap is the separator, so the group drops its own rule and
 * gains the room instead.
 *
 * `:has()` rather than a class on the header: the fold state decides whether the
 * table is drawn at all, and when it is not, the header's rule is the only
 * structure left and has to stay.
 */
.group:has(> .env-grid) > .group-head {
  border-bottom-color: transparent;
  padding-bottom: 10px;
}

.env-card {
  /* A hairline that actually reads. With the card and the page both at
     `--surface`, `--line-soft` sat at 1.15:1 against it — visible on a large
     dark screenshot, invisible on a white page at 100%. The stronger step keeps
     the flat look and still states the row's edge. */
  display: grid;
  grid-template-columns: var(--site-cols);
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  /* Joined rows: the header is the cap, the last row is the foot. */
  border-top: 0;
  border-radius: 0;
  background: var(--surface);
}

.env-card:last-child {
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.env-card:hover {
  border-color: color-mix(in srgb, var(--line) 55%, var(--muted));
}

.env-card.active {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 4%, var(--surface));
}

/* Drag handle: rows carry buttons, so only the grip starts a drag. */
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

/* Insertion line at the top of the row the drag would land on. */
.env-card.drop {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: inset 0 2px 0 var(--accent);
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
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
}

/* The mockup draws facts as 19px chips on the field colour. */
.env-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
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

/* The row's actions, right-aligned so every row's controls end on the same
   vertical line. The split is between "what the row exists for" and "what you
   do to the site itself", hence the wider gap there than between neighbours. */
.card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.card-main,
.card-manage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
</style>
