<script setup lang="ts">
import { computed } from "vue";
import { Layers, Pencil, Play, Plus, Square } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import type { LayoutKey, Scene } from "@shared/types";

const emit = defineEmits<{
  newScene: [];
  editScene: [id: string];
}>();

const store = useWorkspaceStore();

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

function members(scene: Scene) {
  return scene.identityIds
    .map((id) => store.identities.find((identity) => identity.id === id))
    .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
}

function isSceneRunning(scene: Scene): boolean {
  return scene.identityIds.some((id) => Boolean(store.instanceFor(id)));
}

function sceneStatus(scene: Scene): string {
  const running = scene.identityIds.filter((id) => store.instanceFor(id)).length;
  if (running === 0) return "未启动";
  if (running === scene.identityIds.length) return "运行中";
  return `${running} / ${scene.identityIds.length}`;
}

const slots = computed(() => {
  const layout = store.settings.layout;
  return Array.from({ length: columnCount[layout] * (layout === "2x2" ? 2 : 1) });
});
</script>

<template>
  <section class="scenes">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.scenes") }}</h1>
        <p class="mono">一键拉起一组身份 · 自动平铺 · 关闭即回收</p>
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

    <div class="scene-head mono">
      <span>#</span>
      <span>场景</span>
      <span>成员</span>
      <span>布局</span>
      <span></span>
    </div>

    <div class="scene-list">
      <article
        v-for="(scene, index) in store.environmentScenes"
        :key="scene.id"
        class="scene-row"
        :class="{ running: isSceneRunning(scene) }"
      >
        <span class="idx mono">{{ String(index + 1).padStart(2, "0") }}</span>
        <div class="scene-copy">
          <span class="scene-name">{{ scene.name }}</span>
          <span class="scene-sub mono">{{ members(scene).map((m) => m.role).join(" · ") || "—" }}</span>
        </div>
        <div class="members">
          <span
            v-for="identity in members(scene)"
            :key="identity.id"
            class="mchip"
            :class="{ on: Boolean(store.instanceFor(identity.id)) }"
            :style="{ '--role': `var(--role-${identity.color})` }"
          >
            <span class="d">{{ identity.name.slice(0, 1) }}</span>
            {{ identity.name.split(" · ").at(-1) ?? identity.name }}
          </span>
        </div>
        <span class="layout mono">{{ layoutLabel[scene.layout] }}</span>
        <div class="row-actions">
          <button
            class="btn small"
            type="button"
            :class="{ running: isSceneRunning(scene) }"
            :disabled="store.busy === 'launch'"
            @click="isSceneRunning(scene) ? store.stopAll() : store.launchScene(scene.id)"
          >
            <Square v-if="isSceneRunning(scene)" :size="11" />
            <Play v-else :size="11" />
            {{ isSceneRunning(scene) ? $t("app.stop") : $t("app.launch") }}
          </button>
          <button class="icon-btn" type="button" :aria-label="$t('app.edit')" @click="emit('editScene', scene.id)">
            <Pencil :size="12" />
          </button>
          <span class="state mono">{{ sceneStatus(scene) }}</span>
        </div>
      </article>

      <div v-if="!store.environmentScenes.length" class="empty">
        <Layers :size="22" />
        <p>{{ $t("app.emptyScenes") }}</p>
        <button class="btn primary" type="button" @click="emit('newScene')">
          <Plus :size="13" />
          {{ $t("app.newScene") }}
        </button>
      </div>
    </div>

    <div class="layout-section">
      <div class="section-head">
        <span class="section-title mono">窗口布局</span>
        <div class="layout-picker">
          <button
            v-for="layout in (['2x2', '2x1', '3x1', '1x1'] as LayoutKey[])"
            :key="layout"
            type="button"
            class="layout-btn mono"
            :class="{ on: store.settings.layout === layout }"
            @click="store.setLayout(layout)"
          >
            {{ layoutLabel[layout] }}
          </button>
        </div>
      </div>
      <div
        class="layout-stage"
        :class="`cols-${columnCount[store.settings.layout]}`"
        :style="{ gridTemplateRows: store.settings.layout === '2x2' ? '1fr 1fr' : '1fr' }"
      >
        <div
          v-for="(_, index) in slots"
          :key="index"
          class="slot"
          :class="{ filled: index < store.instances.length }"
        >
          <template v-if="store.instances[index]">
            <span
              class="slot-dot"
              :style="{ background: `var(--role-${store.identities.find(i => i.id === store.instances[index]?.identityId)?.color ?? 'slate'})` }"
            ></span>
            {{ store.instances[index]?.label }}
          </template>
          <span v-else class="mono">空闲槽位</span>
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
  padding: 18px 20px 12px;
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
  font-size: 10.5px;
  color: var(--faint);
}

.head-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 11px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover {
  background: var(--surface-3);
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.small {
  padding: 5px 9px;
  font-size: 11px;
}

.btn.small.running {
  border-color: color-mix(in srgb, var(--green) 40%, var(--line));
  color: var(--green);
  background: color-mix(in srgb, var(--green) 8%, transparent);
}

.scene-head,
.scene-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) minmax(0, 1.25fr) 56px 190px;
  align-items: center;
  gap: 12px;
}

.scene-head {
  padding: 12px 12px 6px;
  font-size: 8.5px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--faint);
  flex: 0 0 auto;
}

.scene-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-bottom: 8px;
}

.scene-row {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  padding: 11px 12px;
  background: linear-gradient(90deg, var(--surface), var(--bg-elevated));
  transition: border-color 0.16s ease, background 0.16s ease;
}

.scene-row:hover {
  border-color: var(--line);
}

.scene-row.running {
  border-color: color-mix(in srgb, var(--green) 32%, var(--line));
}

.idx {
  font-size: 9.5px;
  color: var(--faint);
}

.scene-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scene-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scene-sub {
  font-size: 9px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.members {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}

.mchip {
  --role: var(--role-slate);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 3px 7px 3px 4px;
  font-size: 9.5px;
  color: var(--muted);
  background: var(--bg-elevated);
  white-space: nowrap;
}

.mchip.on {
  border-color: color-mix(in srgb, var(--role) 50%, var(--line));
  color: var(--text);
  background: color-mix(in srgb, var(--role) 8%, var(--bg-elevated));
}

.mchip .d {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--role);
  color: var(--accent-foreground);
  font-size: 7px;
  font-weight: 500;
}

.layout {
  font-size: 9.5px;
  color: var(--muted);
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.icon-btn {
  width: 26px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--faint);
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.state {
  font-size: 9px;
  color: var(--faint);
  width: 42px;
  text-align: right;
}

.empty {
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  padding: 34px 20px;
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

.layout-section {
  flex: 0 0 auto;
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.section-title {
  font-size: 8.5px;
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
  font-size: 9px;
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
  height: 78px;
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
  font-size: 9px;
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

@media (max-width: 1100px) {
  .scene-head,
  .scene-row {
    grid-template-columns: 24px minmax(0, 1fr) minmax(0, 0.9fr) 150px;
  }

  .layout {
    display: none;
  }
}

@media (max-width: 900px) {
  .scenes {
    padding: 14px;
  }

  .scene-head {
    display: none;
  }

  .scene-row {
    grid-template-columns: 20px minmax(0, 1fr);
    row-gap: 8px;
  }

  .members {
    grid-column: 2;
  }

  .row-actions {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>
