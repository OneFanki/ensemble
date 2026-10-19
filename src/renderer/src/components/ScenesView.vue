<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { Layers, Pencil, Play, Plus, Square, Trash2 } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import type { LayoutKey, Scene } from "@shared/types";

const emit = defineEmits<{
  newScene: [];
  editScene: [id: string];
  deleteScene: [id: string];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const layoutLabel: Record<LayoutKey, string> = {
  "1x1": "1 × 1",
  "2x1": "2 × 1",
  "2x2": "2 × 2",
  "3x1": "3 × 1",
};

const columnCount: Record<LayoutKey, number> = {
  "1x1": 1,
  "2x1": 2,
  "2x2": 2,
  "3x1": 3,
};

const layouts: LayoutKey[] = ["2x2", "2x1", "3x1", "1x1"];
const selectedSceneId = ref("");

const selectedScene = computed<Scene | undefined>(
  () =>
    store.environmentScenes.find((scene) => scene.id === selectedSceneId.value) ??
    store.environmentScenes[0],
);

// Keep the selection valid when scenes are added, renamed or deleted.
watchEffect(() => {
  const current = selectedScene.value;
  if (current && current.id !== selectedSceneId.value) selectedSceneId.value = current.id;
});

const activeLayout = computed<LayoutKey>(() => selectedScene.value?.layout ?? "2x2");

const slots = computed(() =>
  Array.from({ length: columnCount[activeLayout.value] * (activeLayout.value === "2x2" ? 2 : 1) }),
);

const runningMembers = computed(() =>
  selectedScene.value
    ? selectedScene.value.identityIds.filter((id) => Boolean(store.instanceFor(id))).length
    : 0,
);
const isRunning = computed(() => runningMembers.value > 0);

function members(scene: Scene) {
  return scene.identityIds
    .map((id) => store.identities.find((identity) => identity.id === id))
    .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
}

function sceneStatus(scene: Scene): string {
  const running = scene.identityIds.filter((id) => store.instanceFor(id)).length;
  if (running === 0) return t("app.notStarted");
  if (running === scene.identityIds.length) return t("app.statusRunning");
  return `${running} / ${scene.identityIds.length}`;
}

function chooseLayout(layout: LayoutKey) {
  const scene = selectedScene.value;
  if (!scene) return;
  void store.setSceneLayout(scene.id, layout);
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
        <button class="btn" type="button" @click="store.launchCleanSession()">
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
          <span class="layout mono">{{ layoutLabel[scene.layout] }}</span>
          <span class="state mono">{{ sceneStatus(scene) }}</span>
        </button>
      </div>

      <div v-if="selectedScene" class="detail">
        <div class="detail-head">
          <div class="detail-copy">
            <h2>{{ selectedScene.name }}</h2>
            <p class="detail-sub">
              {{ $t("app.identityCount", { count: selectedScene.identityIds.length }) }} ·
              {{ $t("app.layoutLabel", { layout: selectedScene.layout.replace("x", " × ") }) }}
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

        <div class="member-list">
          <span
            v-for="identity in members(selectedScene)"
            :key="identity.id"
            class="mchip"
            :class="{ on: Boolean(store.instanceFor(identity.id)) }"
            :style="{ '--role': `var(--role-${identity.color})` }"
          >
            <span class="d">{{ identity.name.slice(0, 1) }}</span>
            <span class="m-name">{{ identity.name }}</span>
            <span class="m-role mono">{{ identity.role }}</span>
            <span v-if="store.instanceFor(identity.id)" class="m-live">{{ $t("app.statusRunning") }}</span>
          </span>
        </div>

        <div class="layout-block">
          <div class="section-head">
            <span class="section-title">{{ $t("app.windowLayout") }}</span>
            <div class="layout-picker">
              <button
                v-for="layout in layouts"
                :key="layout"
                type="button"
                class="layout-btn mono"
                :class="{ on: activeLayout === layout }"
                @click="chooseLayout(layout)"
              >
                {{ layoutLabel[layout] }}
              </button>
            </div>
          </div>
          <div
            class="layout-stage"
            :class="`cols-${columnCount[activeLayout]}`"
            :style="{ gridTemplateRows: activeLayout === '2x2' ? '1fr 1fr' : '1fr' }"
          >
            <div
              v-for="(_, index) in slots"
              :key="index"
              class="slot"
              :class="{ filled: index < selectedScene.identityIds.length }"
            >
              <template v-if="members(selectedScene)[index]">
                <span
                  class="slot-dot"
                  :style="{ background: `var(--role-${members(selectedScene)[index]?.color ?? 'slate'})` }"
                ></span>
                {{ members(selectedScene)[index]?.name }}
              </template>
              <span v-else>{{ $t("app.idleSlot") }}</span>
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

.head-copy p {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--faint);
}

.head-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
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

.member-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mchip {
  --role: var(--role-slate);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 4px 9px 4px 5px;
  font-size: 11.5px;
  color: var(--muted);
  background: var(--bg-elevated);
}

.mchip.on {
  border-color: color-mix(in srgb, var(--role) 50%, var(--line));
  color: var(--text);
  background: color-mix(in srgb, var(--role) 8%, var(--bg-elevated));
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

.layout-picker {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.layout-btn {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10.5px;
  padding: 4px 7px;
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

.layout-stage {
  display: grid;
  gap: 5px;
  height: 128px;
}

.layout-stage.cols-1 {
  grid-template-columns: 1fr;
}

.layout-stage.cols-2 {
  grid-template-columns: 1fr 1fr;
}

.layout-stage.cols-3 {
  grid-template-columns: repeat(3, 1fr);
}

.slot {
  border: 1px dashed color-mix(in srgb, var(--line) 80%, transparent);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px;
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.slot.filled {
  border-style: solid;
  border-color: color-mix(in srgb, var(--green) 30%, var(--line));
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--green) 5%, var(--bg-elevated));
}

.slot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
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

@media (max-width: 1080px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .scene-list {
    max-height: 180px;
  }
}
</style>
