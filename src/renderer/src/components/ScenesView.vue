<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import {
  Globe,
  GripVertical,
  Layers,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Wand2,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import { isFreeLayout, resolveSlotAssignments } from "@shared/layouts";
import type { Identity, LayoutPreset, Scene } from "@shared/types";

const emit = defineEmits<{
  newScene: [];
  editScene: [id: string];
  deleteScene: [id: string];
  editLayout: [preset?: LayoutPreset, sceneId?: string];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const selectedSceneId = ref("");
const selectedMemberId = ref<string | null>(null);
const draggedId = ref<string | null>(null);
const dropTarget = ref<number | null>(null);

const selectedScene = computed<Scene | undefined>(
  () =>
    store.environmentScenes.find((scene) => scene.id === selectedSceneId.value) ??
    store.environmentScenes[0],
);

// Keep the selection valid when scenes are added, renamed or deleted.
watchEffect(() => {
  const current = selectedScene.value;
  if (current && current.id !== selectedSceneId.value) selectedSceneId.value = current.id;
  if (!current) selectedMemberId.value = null;
});

const activePreset = computed<LayoutPreset>(() => store.presetById(selectedScene.value?.layoutId));

const isFree = computed(() => isFreeLayout(activePreset.value));

function members(scene: Scene): Identity[] {
  return scene.identityIds
    .map((id) => store.identities.find((identity) => identity.id === id))
    .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
}

function sceneStatus(scene: Scene): string {
  const running = scene.identityIds.filter((id) => store.instanceFor(id)).length;
  if (running === 0) return t("app.notStarted");
  return `${running} / ${scene.identityIds.length}`;
}

const runningMembers = computed(() =>
  selectedScene.value
    ? selectedScene.value.identityIds.filter((id) => store.instanceFor(id)).length
    : 0,
);
const isRunning = computed(() => runningMembers.value > 0);

/**
 * Explicit assignments first, then the remaining members fill the remaining
 * slots in member order. This keeps old scenes (no assignments) working while
 * making drag-and-drop the source of truth once used.
 */
function effectiveAssignments(scene: Scene, preset: LayoutPreset): Record<string, number> {
  return resolveSlotAssignments(preset, scene.identityIds, scene.slotAssignments);
}

const assignments = computed(() =>
  selectedScene.value ? effectiveAssignments(selectedScene.value, activePreset.value) : {},
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
  const scene = selectedScene.value;
  if (!scene) return;
  const preset = activePreset.value;
  if (preset.slots.length === 0) return;

  const current = { ...effectiveAssignments(scene, preset) };
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
  await store.setSceneSlots(scene.id, current);
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
  const scene = selectedScene.value;
  if (!scene) return;
  const from = memberAt(fromSlot);
  const to = memberAt(toSlot);
  const current = { ...assignments.value };
  if (from) current[from.id] = toSlot;
  if (to) current[to.id] = fromSlot;
  await store.setSceneSlots(scene.id, current);
}

function onSlotClick(slotIndex: number) {
  if (selectedMemberId.value) void assign(selectedMemberId.value, slotIndex);
}

function selectMember(identityId: string) {
  selectedMemberId.value = selectedMemberId.value === identityId ? null : identityId;
}

function chooseLayout(preset: LayoutPreset) {
  const scene = selectedScene.value;
  if (!scene || scene.layoutId === preset.id) return;
  void store.setSceneLayout(scene.id, preset.id);
}

function editActiveLayout() {
  const scene = selectedScene.value;
  if (!scene) return;
  emit("editLayout", activePreset.value, scene.id);
}

function launchSelected() {
  const scene = selectedScene.value;
  if (!scene) return;
  if (isRunning.value) void store.stopAll();
  else void store.launchScene(scene.id);
}
</script>

<template>
  <section class="scenes">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.scenes") }}</h1>
        <p class="head-note">{{ $t("app.scenesSubtitle") }}</p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="store.launchScopedCleanSession()">
          <Globe :size="13" />
          {{ $t("app.cleanSession") }}
        </button>
        <button class="btn primary" type="button" @click="emit('newScene')">
          <Plus :size="13" />
          {{ $t("app.newScene") }}
        </button>
      </div>
    </header>

    <div v-if="!store.environmentScenes.length" class="empty">
      <Layers :size="22" />
      <p>{{ $t("app.emptyScenes") }}</p>
      <button class="btn primary" type="button" @click="emit('newScene')">
        <Plus :size="13" />
        {{ $t("app.newScene") }}
      </button>
    </div>

    <div v-else class="workspace">
      <div class="scene-list" role="listbox" :aria-label="$t('app.sceneColumnName')">
        <button
          v-for="(scene, index) in store.environmentScenes"
          :key="scene.id"
          type="button"
          role="option"
          class="scene-row"
          :class="{ running: sceneStatus(scene) !== $t('app.notStarted'), selected: scene.id === selectedScene?.id }"
          :aria-selected="scene.id === selectedScene?.id"
          @click="selectedSceneId = scene.id"
        >
          <span class="idx mono">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="scene-copy">
            <span class="scene-name">{{ scene.name }}</span>
            <span class="scene-sub mono">{{ members(scene).map((m) => m.role).join(" · ") || "—" }}</span>
          </span>
          <span class="layout mono">{{ store.presetName(store.presetById(scene.layoutId)) }}</span>
          <span class="state mono">{{ sceneStatus(scene) }}</span>
        </button>
      </div>

      <div v-if="selectedScene" class="detail">
        <div class="detail-head">
          <div class="detail-copy">
            <h2>{{ selectedScene.name }}</h2>
            <p class="detail-sub">
              {{ $t("app.identityCount", { count: selectedScene.identityIds.length }) }} ·
              {{ store.presetName(activePreset) }}
            </p>
          </div>
          <div class="detail-actions">
            <button
              class="btn small"
              type="button"
              :class="{ running: isRunning }"
              :disabled="store.busy === 'launch'"
              @click="launchSelected"
            >
              <Square v-if="isRunning" :size="11" />
              <Play v-else :size="11" />
              {{ isRunning ? $t("app.stop") : $t("app.runScene") }}
            </button>
            <button
              class="icon-btn"
              type="button"
              :aria-label="$t('app.edit')"
              @click="emit('editScene', selectedScene.id)"
            >
              <Pencil :size="12" />
            </button>
            <button
              class="icon-btn danger"
              type="button"
              :aria-label="$t('app.delete')"
              @click="emit('deleteScene', selectedScene.id)"
            >
              <Trash2 :size="12" />
            </button>
          </div>
        </div>

        <div class="member-pool">
          <div
            v-for="identity in members(selectedScene)"
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
              @click.stop="store.launchSceneMember(selectedScene!.id, identity.id)"
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
              v-for="preset in store.layoutPresets"
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

          <p class="layout-note">{{ $t("app.sceneOrderNote") }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.scenes {
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

/* Same guard as the environments page: the copy shrinks, the buttons never do. */
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

.scene-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

.scene-row {
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

.scene-row:hover {
  border-color: var(--line);
  color: var(--text-secondary);
}

.scene-row.selected {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--line));
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
  color: var(--text);
}

.scene-row.running .state {
  color: var(--green);
}

.idx {
  font-size: 11px;
  color: var(--faint);
}

.scene-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.scene-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scene-sub {
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

.icon-btn {
  width: 28px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--faint);
  border: 1px solid var(--line-soft);
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.icon-btn.danger:hover {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--line));
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

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 11px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
}

.btn.small {
  padding: 6px 10px;
}

.btn.running {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 35%, var(--line));
}

.btn.primary {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.primary:hover:not(:disabled) {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}

@media (max-width: 1080px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .scene-list {
    max-height: 180px;
  }
}
</style>
