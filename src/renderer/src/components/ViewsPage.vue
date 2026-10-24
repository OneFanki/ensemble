<script setup lang="ts">
import { isFreeLayout, resolveSlotAssignments } from "@shared/layouts";
import type { Identity, LayoutPreset, View } from "@shared/types";
import {
  Copy,
  GripVertical,
  Layers,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Wand2,
} from "lucide-vue-next";
import { computed, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";

const emit = defineEmits<{
  newView: [];
  editView: [id: string];
  deleteView: [id: string];
  editLayout: [preset?: LayoutPreset, viewId?: string];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();

const selectedViewId = ref("");
const selectedMemberId = ref<string | null>(null);
const draggedId = ref<string | null>(null);
const dropTarget = ref<number | null>(null);
/** Target site of the "copy to another site" dialog. */
const copyTargetId = ref<string | null>(null);
/** Filters: a view matches if any member (or the view) belongs to this site/tag. */
const siteFilter = ref<string | null>(null);
const tagFilter = ref<string | null>(null);

function siteIdsOf(view: View): string[] {
  const ids = new Set<string>();
  for (const identityId of view.identityIds) {
    const identity = store.identities.find((item) => item.id === identityId);
    if (identity) ids.add(identity.siteId);
  }
  return [...ids];
}

const visibleViews = computed(() =>
  store.views.filter((view) => {
    if (siteFilter.value && !siteIdsOf(view).includes(siteFilter.value)) return false;
    if (tagFilter.value && !store.tagsForView(view).includes(tagFilter.value)) return false;
    return true;
  }),
);

/** Only sites and tags that some view actually uses; a dead filter is noise. */
const filterSites = computed(() => {
  const used = new Set<string>();
  for (const view of store.views) for (const id of siteIdsOf(view)) used.add(id);
  return store.sites.filter((site) => used.has(site.id));
});

const filterTags = computed(() => {
  const used = new Set<string>();
  for (const view of store.views) for (const id of store.tagsForView(view)) used.add(id);
  return (store.snapshot?.tags ?? []).filter((tag) => used.has(tag.id));
});

const selectedView = computed<View | undefined>(
  () =>
    visibleViews.value.find((view) => view.id === selectedViewId.value) ?? visibleViews.value[0],
);

// Keep the selection valid when views are added, renamed or deleted.
watchEffect(() => {
  const current = selectedView.value;
  if (current && current.id !== selectedViewId.value) selectedViewId.value = current.id;
  if (!current) selectedMemberId.value = null;
});

const activePreset = computed<LayoutPreset>(() => store.presetById(selectedView.value?.layoutId));

const isFree = computed(() => isFreeLayout(activePreset.value));

function members(view: View): Identity[] {
  return view.identityIds
    .map((id) => store.identities.find((identity) => identity.id === id))
    .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
}

function viewStatus(view: View): string {
  if (openContainer(view)) return t("app.browserStage");
  const running = view.identityIds.filter((id) => store.instanceFor(id)).length;
  if (running === 0) return t("app.notStarted");
  return `${running} / ${view.identityIds.length}`;
}

const runningMembers = computed(() =>
  selectedView.value
    ? selectedView.value.identityIds.filter((id) => store.instanceFor(id)).length
    : 0,
);
const isRunning = computed(() => runningMembers.value > 0);

/**
 * Explicit assignments first, then the remaining members fill the remaining
 * slots in member order. This keeps old views (no assignments) working while
 * making drag-and-drop the source of truth once used.
 */
function effectiveAssignments(view: View, preset: LayoutPreset): Record<string, number> {
  return resolveSlotAssignments(preset, view.identityIds, view.slotAssignments);
}

const assignments = computed(() =>
  selectedView.value ? effectiveAssignments(selectedView.value, activePreset.value) : {},
);

function memberAt(slotIndex: number): Identity | undefined {
  const identityId = Object.entries(assignments.value).find(([, slot]) => slot === slotIndex)?.[0];
  if (!identityId) return undefined;
  return store.identities.find((identity) => identity.id === identityId);
}

function canReopen(identity: Identity): boolean {
  return !store.instanceFor(identity.id) && isRunning.value;
}

async function assign(identityId: string, slotIndex: number) {
  const view = selectedView.value;
  if (!view) return;
  const preset = activePreset.value;
  if (preset.slots.length === 0) return;

  const current = { ...effectiveAssignments(view, preset) };
  const previousOwner = Object.entries(current).find(([, slot]) => slot === slotIndex)?.[0];
  const previousSlot = current[identityId];

  if (previousOwner && previousOwner !== identityId) {
    // Dropping on an occupied slot swaps the two windows instead of evicting.
    if (previousSlot === undefined) {
      delete current[previousOwner];
    } else {
      current[previousOwner] = previousSlot;
    }
  }
  current[identityId] = slotIndex;
  await store.setViewSlots(view.id, current);
}

function onDrop(event: DragEvent, slotIndex: number) {
  event.preventDefault();
  const payload = event.dataTransfer?.getData("text/plain") || draggedId.value;
  dropTarget.value = null;
  draggedId.value = null;
  if (!payload) return;
  if (payload.startsWith("slot:")) {
    const fromSlot = Number.parseInt(payload.slice(5), 10);
    if (Number.isInteger(fromSlot) && fromSlot !== slotIndex) void swapSlots(fromSlot, slotIndex);
    return;
  }
  void assign(payload, slotIndex);
}

/** Slot-to-slot drop swaps the two owners, which is how people reorder windows. */
async function swapSlots(fromSlot: number, toSlot: number) {
  const view = selectedView.value;
  if (!view) return;
  const from = memberAt(fromSlot);
  const to = memberAt(toSlot);
  const current = { ...assignments.value };
  if (from) current[from.id] = toSlot;
  if (to) current[to.id] = fromSlot;
  await store.setViewSlots(view.id, current);
}

function onSlotClick(slotIndex: number) {
  if (selectedMemberId.value) void assign(selectedMemberId.value, slotIndex);
}

function selectMember(identityId: string) {
  selectedMemberId.value = selectedMemberId.value === identityId ? null : identityId;
}

function chooseLayout(preset: LayoutPreset) {
  const view = selectedView.value;
  if (!view || view.layoutId === preset.id) return;
  void store.setViewLayout(view.id, preset.id);
}

function editActiveLayout() {
  const view = selectedView.value;
  if (!view) return;
  emit("editLayout", activePreset.value, view.id);
}

/** The container this definition has open on the built-in surface, if any. */
function openContainer(view: View) {
  return embedded.views.find((item) => item.viewDefinitionId === view.id);
}

/** The title bar's launch target decides which surface this button acts on. */
const launchTarget = computed(() => store.settings.launchTarget ?? "embedded");

/** Whether this view is running on the surface the launch switch points at. */
const runningHere = computed(() => {
  const view = selectedView.value;
  if (!view) return false;
  return launchTarget.value === "embedded"
    ? Boolean(openContainer(view))
    : view.identityIds.some((id) => store.instanceFor(id));
});

const launchLabel = computed(() => {
  if (launchTarget.value === "embedded") {
    return runningHere.value ? t("app.browserStopView") : t("app.runView");
  }
  return runningHere.value ? t("app.closeViewWindows") : t("app.runExternal");
});

/**
 * One action, routed by the title bar.
 *
 * Two buttons side by side ("run" and "run external") made the same decision
 * twice and forced every user to re-answer it per view. The switch in the title
 * bar is the single place that decides.
 */
async function launchHere() {
  const view = selectedView.value;
  if (!view) return;
  if (launchTarget.value === "embedded") {
    const container = openContainer(view);
    if (container) {
      await embedded.closeView(container.id, "opened");
      return;
    }
    await embedded.openView(view.id);
    return;
  }
  if (view.identityIds.some((id) => store.instanceFor(id))) await store.stopView(view.id);
  else await store.launchView(view.id);
}

/** Other sites this view can be copied to; the source site is excluded. */
const copyTargets = computed(() =>
  store.sites.filter((site) => site.id !== selectedView.value?.siteId),
);

const copyTargetOptions = computed(() =>
  copyTargets.value.map((site) => ({
    value: site.id,
    label: site.name,
    hint: site.baseUrl,
  })),
);

async function confirmCopy(): Promise<void> {
  const view = selectedView.value;
  const targetId = copyTargetId.value;
  if (!view || !targetId) return;
  const result = await store.copyViewToSite(view.id, targetId);
  copyTargetId.value = null;
  if (!result) return;
  const parts = [
    t("app.copyViewDone", { name: result.view.name }),
    result.createdReferences.length
      ? t("app.copyViewReferenced", { count: result.createdReferences.length })
      : "",
    result.reused.length ? t("app.copyViewReused", { count: result.reused.length }) : "",
    result.skipped.length ? t("app.copyViewSkipped", { names: result.skipped.join("、") }) : "",
  ].filter(Boolean);
  store.notify(parts.join(" · "), result.skipped.length ? "info" : "success");
}
</script>

<template>
  <section class="views">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.views") }}</h1>
        <p class="head-note">{{ $t("app.viewsSubtitle") }}</p>
      </div>
      <div class="head-actions">
        <AppButton variant="primary" data-tour="new-view" @click="emit('newView')">
          <Plus :size="13" />
          {{ $t("app.newView") }}
        </AppButton>
      </div>
    </header>

    <div v-if="!store.views.length" class="empty">
      <Layers :size="22" />
      <p>{{ $t("app.emptyViews") }}</p>
      <AppButton variant="primary" @click="emit('newView')">
        <Plus :size="13" />
        {{ $t("app.newView") }}
      </AppButton>
    </div>

    <div v-else class="workspace">
      <div class="view-list" role="listbox" :aria-label="$t('app.viewColumnName')">
        <!-- Filters match members, not just the view's own tags: "show me the
             views that touch 生产" should not require tagging each view twice. -->
        <div v-if="filterSites.length || filterTags.length" class="filters">
          <button
            v-for="site in filterSites"
            :key="site.id"
            type="button"
            class="filter-chip"
            :class="{ on: siteFilter === site.id }"
            @click="siteFilter = siteFilter === site.id ? null : site.id"
          >
            {{ site.name }}
          </button>
          <button
            v-for="tag in filterTags"
            :key="tag.id"
            type="button"
            class="filter-chip"
            :class="{ on: tagFilter === tag.id }"
            :style="{ '--tag': `var(--role-${tag.color})` }"
            @click="tagFilter = tagFilter === tag.id ? null : tag.id"
          >
            <span class="chip-dot"></span>
            {{ tag.name }}
          </button>
        </div>
        <button
          v-for="(view, index) in visibleViews"
          :key="view.id"
          type="button"
          role="option"
          class="view-row"
          :class="{ running: viewStatus(view) !== $t('app.notStarted'), selected: view.id === selectedView?.id }"
          :aria-selected="view.id === selectedView?.id"
          @click="selectedViewId = view.id"
        >
          <span class="idx mono">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="view-copy">
            <span class="view-name">{{ view.name }}</span>
            <span class="view-sub mono">{{ members(view).map((m) => m.role).join(" · ") || "—" }}</span>
          </span>
          <span class="layout mono">{{ store.presetName(store.presetById(view.layoutId)) }}</span>
          <span class="state mono">{{ viewStatus(view) }}</span>
        </button>
        <p v-if="!visibleViews.length" class="no-match">{{ $t("app.noMatchingViews") }}</p>
      </div>

      <div v-if="selectedView" class="detail">
        <div class="detail-head">
          <div class="detail-copy">
            <h2>{{ selectedView.name }}</h2>
            <p class="detail-sub">
              {{ $t("app.identityCount", { count: selectedView.identityIds.length }) }} ·
              {{ store.presetName(activePreset) }}
            </p>
          </div>
          <div class="detail-actions">
            <AppButton size="sm" :class="{ running: runningHere }"
              :disabled="store.busy === 'launch'"
              @click="launchHere">
              <Square v-if="runningHere" :size="11" />
              <Play v-else :size="11" />
              {{ launchLabel }}
            </AppButton>
            <IconButton :ariaLabel="$t('app.copyViewToSite')"
              :title="$t('app.copyViewToSiteHint')"
              :disabled="!copyTargets.length"
              @click="copyTargetId = copyTargets[0]?.id ?? null">
              <Copy :size="12" />
            </IconButton>
            <IconButton :ariaLabel="$t('app.edit')"
              @click="emit('editView', selectedView.id)">
              <Pencil :size="12" />
            </IconButton>
            <IconButton variant="danger" :ariaLabel="$t('app.delete')"
              @click="emit('deleteView', selectedView.id)">
              <Trash2 :size="12" />
            </IconButton>
          </div>
        </div>

        <div class="member-pool">
          <div
            v-for="identity in members(selectedView)"
            :key="identity.id"
            class="mchip"
            :class="{
              on: Boolean(store.instanceFor(identity.id)),
              picked: selectedMemberId === identity.id,
              dragging: draggedId === identity.id,
            }"
            :style="{ '--role': `var(--role-${identity.color})` }"
            :draggable="!isFree"
            @dragstart="draggedId = identity.id; $event.dataTransfer?.setData('text/plain', identity.id)"
            @dragend="draggedId = null; dropTarget = null"
            @click="selectMember(identity.id)"
          >
            <GripVertical v-if="!isFree" :size="10" class="grip" />
            <span class="d">{{ identity.name.slice(0, 1) }}</span>
            <span class="m-name">{{ identity.name }}</span>
            <span class="m-role mono">{{ identity.role }}</span>
            <span v-if="store.instanceFor(identity.id)" class="m-live">{{ $t("app.statusRunning") }}</span>
            <button
              v-else-if="canReopen(identity)"
              type="button"
              class="m-open"
              :disabled="store.busy === 'launch'"
              @click.stop="store.launchViewMember(selectedView!.id, identity.id)"
            >
              {{ $t("app.reopen") }}
            </button>
          </div>
          <p v-if="!isFree" class="pool-hint">{{ $t("app.slotDragHint") }}</p>
        </div>

        <div class="layout-block">
          <div class="section-head">
            <span class="section-title">{{ $t("app.windowLayout") }}</span>
            <button type="button" class="link-btn" @click="editActiveLayout">
              <Wand2 :size="11" />
              {{ $t("app.customizeLayout") }}
            </button>
          </div>
          <div class="layout-picker">
            <button
              v-for="preset in store.viewLayoutPresets"
              :key="preset.id"
              type="button"
              class="layout-btn"
              :class="{ on: activePreset.id === preset.id }"
              @click="chooseLayout(preset)"
            >
              {{ store.presetName(preset) }}
              <span v-if="!preset.builtin" class="custom-tag">{{ $t("app.customTag") }}</span>
            </button>
          </div>

          <div v-if="isFree" class="free-block">
            <p class="free-title">{{ $t("app.freeLayoutTitle") }}</p>
            <p class="free-note">{{ $t("app.freeLayoutNote") }}</p>
          </div>

          <div v-else class="slot-stage">
            <div
              v-for="(slot, index) in activePreset.slots"
              :key="index"
              class="slot"
              :class="{ filled: Boolean(memberAt(index)), over: dropTarget === index }"
              :style="{
                left: `${slot.x * 100}%`,
                top: `${slot.y * 100}%`,
                width: `${slot.width * 100}%`,
                height: `${slot.height * 100}%`,
              }"
              :draggable="Boolean(memberAt(index))"
              @dragstart="
                draggedId = memberAt(index)?.id ?? null;
                $event.dataTransfer?.setData('text/plain', `slot:${index}`)
              "
              @dragend="draggedId = null; dropTarget = null"
              @dragover.prevent="dropTarget = index"
              @dragleave="dropTarget === index ? (dropTarget = null) : null"
              @drop="onDrop($event, index)"
              @click="onSlotClick(index)"
            >
              <template v-if="memberAt(index)">
                <span
                  class="slot-dot"
                  :style="{ background: `var(--role-${memberAt(index)?.color ?? 'slate'})` }"
                ></span>
                <span class="slot-name">{{ memberAt(index)?.name }}</span>
                <span v-if="store.instanceFor(memberAt(index)!.id)" class="slot-live mono">●</span>
              </template>
              <span v-else class="slot-empty">{{ $t("app.freeSlot", { index: index + 1 }) }}</span>
            </div>
          </div>

          <p class="layout-note">{{ $t("app.viewOrderNote") }}</p>
        </div>
      </div>
    </div>

    <!-- Copying a view to another site is one explicit action: members are matched
         by username, and accounts that do not exist there become references. -->
    <Modal
      v-if="copyTargetId && selectedView"
      :open="true"
      :title="$t('app.copyViewToSite')"
      :description="$t('app.copyViewToSiteDesc')"
      width="460px"
      @close="copyTargetId = null"
    >
      <div class="copy-form">
        <label class="copy-field">
          <span class="copy-label">{{ $t("app.copyTargetSite") }}</span>
          <SelectField
            :model-value="copyTargetId ?? undefined"
            :options="copyTargetOptions"
            :aria-label="$t('app.copyTargetSite')"
            @update:model-value="copyTargetId = $event ?? null"
          />
        </label>
        <p class="copy-note">{{ $t("app.copyViewNote", { count: selectedView.identityIds.length }) }}</p>
      </div>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="copyTargetId = null">
          {{ $t("app.cancel") }}
        </AppButton>
        <AppButton variant="primary" :disabled="store.busy === 'view'"
          @click="confirmCopy">
          {{ $t("app.copy") }}
        </AppButton>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.views {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 14px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex: 0 0 auto;
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
}

/* Same guard as the sites page: the copy shrinks, the buttons never do. */
.head-copy {
  min-width: 0;
  flex: 1 1 auto;
}

.head-copy p {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--faint);
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.workspace {
  margin-top: 16px;
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  flex: 1 1 auto;
}

.view-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

/* Same rule as the account page: a single scrolling line, because a workspace
   with many tags would otherwise fill the whole left column with chips. */
.filters {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 4px;
  scrollbar-width: thin;
}

.filter-chip {
  background: transparent;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
}

.filter-chip.on {
  border-color: color-mix(in srgb, var(--accent) 46%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text-secondary);
}

.filter-chip .chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tag, var(--accent));
  opacity: 0.8;
}

.no-match {
  margin: 12px 4px;
  font-size: 11.5px;
  color: var(--faint);
}

.view-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 9px 10px;
  color: var(--muted);
}

.view-row:hover {
  border-color: var(--line);
  color: var(--text-secondary);
}

.view-row.selected {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--line));
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
  color: var(--text);
}

.view-row.running .state {
  color: var(--green);
}

.idx {
  font-size: 11px;
  color: var(--faint);
}

.view-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.view-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-sub {
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.layout {
  font-size: 11px;
  color: var(--faint);
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
}

.detail {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.detail-copy h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.detail-sub {
  margin: 5px 0 0;
  font-size: 11.5px;
  color: var(--faint);
}

.detail-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.member-pool {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mchip {
  --role: var(--role-slate);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 4px 9px 4px 5px;
  font-size: 11.5px;
  color: var(--muted);
  background: var(--bg-elevated);
  cursor: grab;
  user-select: none;
}

.mchip.on {
  border-color: color-mix(in srgb, var(--role) 50%, var(--line));
  color: var(--text);
  background: color-mix(in srgb, var(--role) 8%, var(--bg-elevated));
}

.mchip.picked {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.mchip.dragging {
  opacity: 0.5;
}

.grip {
  color: var(--faint);
  flex: 0 0 auto;
}

.mchip .d {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--role);
  color: var(--accent-foreground);
  font-size: 9px;
  font-weight: 500;
}

.m-role {
  font-size: 10px;
  color: var(--faint);
}

.m-live {
  font-size: 10px;
  color: var(--green);
}

.m-open {
  font-size: 10px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
  border-radius: 999px;
  padding: 1px 6px;
}

.m-open:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.pool-hint {
  margin: 0;
  width: 100%;
  font-size: 10.5px;
  color: var(--faint);
}

.layout-block {
  border-top: 1px solid var(--line-soft);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
}

.link-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--accent);
}

.link-btn:hover {
  text-decoration: underline;
}

.layout-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.layout-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10.5px;
  padding: 4px 9px;
}

.layout-btn:hover {
  color: var(--text-secondary);
  border-color: var(--line);
}

.layout-btn.on {
  color: var(--accent-foreground);
  background: var(--accent);
  border-color: var(--accent);
  font-weight: 500;
}

.custom-tag {
  font-size: 9px;
  opacity: 0.72;
}

.slot-stage {
  position: relative;
  height: 190px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  overflow: hidden;
}

.slot {
  position: absolute;
  border: 1px dashed color-mix(in srgb, var(--line) 80%, transparent);
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px;
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.slot.filled {
  border-style: solid;
  border-color: color-mix(in srgb, var(--green) 30%, var(--line));
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--green) 5%, var(--bg-elevated));
}

.slot.over {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-elevated));
}

.slot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
}

.slot-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.slot-live {
  margin-left: auto;
  font-size: 8px;
  color: var(--green);
}

.slot-empty {
  color: var(--faint);
}

.free-block {
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.free-title {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.free-note {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
}

.layout-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--faint);
}

.empty {
  margin-top: 28px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.empty p {
  margin: 0;
}

.btn.small {
  padding: 6px 10px;
}

.btn.running {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 35%, var(--line));
}

@media (max-width: 1080px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .view-list {
    max-height: 180px;
  }
}

.copy-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.copy-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.copy-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.copy-input {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  padding: 7px 9px;
  font-size: 11.5px;
  outline: 0;
}

.copy-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--faint);
}

.spacer {
  flex: 1;
}
</style>
