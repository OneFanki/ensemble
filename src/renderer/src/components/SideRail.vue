<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Layers,
  Monitor,
  Pencil,
  Play,
  Plus,
  Settings2,
  Users,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

defineProps<{ view: "identities" | "scenes" | "settings" }>();
const emit = defineEmits<{
  navigate: [view: "identities" | "scenes" | "settings"];
  newEnvironment: [];
  editEnvironment: [];
  newScene: [];
}>();

const store = useWorkspaceStore();
const collapsed = ref(false);

const envKind = (kind: string) => (kind === "prod" ? "PROD" : kind === "staging" ? "STG" : "LOCAL");
const envColor = (kind: string) =>
  kind === "prod" ? "var(--red)" : kind === "staging" ? "var(--blue)" : "var(--accent)";

const activeSceneCount = computed(() => store.environmentScenes.length);
</script>

<template>
  <aside class="rail">
    <div class="rail-head">
      <span class="rail-title">{{ $t("app.railEnvironment") }}</span>
      <div class="rail-tools">
        <button
          class="tool"
          type="button"
          :aria-label="$t('app.newEnvironment')"
          :title="$t('app.newEnvironment')"
          @click="emit('newEnvironment')"
        >
          <Plus :size="12" />
        </button>
      </div>
    </div>

    <div class="env-list">
      <button
        v-for="env in store.environments"
        :key="env.id"
        type="button"
        class="rail-item"
        :class="{ active: env.id === store.activeEnvironment?.id }"
        @click="store.setActiveEnvironment(env.id)"
        @dblclick="emit('editEnvironment')"
      >
        <span class="env-dot" :style="{ background: envColor(env.kind) }"></span>
        <span class="env-name">{{ env.name }}</span>
        <span class="env-kind mono">{{ envKind(env.kind) }}</span>
      </button>

      <button v-if="!store.environments.length" type="button" class="empty-env" @click="emit('newEnvironment')">
        <Plus :size="12" />
        {{ $t("app.newEnvironment") }}
      </button>
    </div>

    <button
      v-if="store.activeEnvironment"
      class="rail-sub"
      type="button"
      @click="emit('editEnvironment')"
    >
      <Pencil :size="11" />
      {{ $t("app.editEnvironment") }}
    </button>

    <div class="rail-sep"></div>

    <div class="rail-head">
      <span class="rail-title">{{ $t("app.nav") }}</span>
    </div>

    <nav class="nav">
      <button
        type="button"
        class="nav-item"
        :class="{ active: view === 'identities' }"
        @click="emit('navigate', 'identities')"
      >
        <Users :size="14" />
        <span>{{ $t("app.identities") }}</span>
        <span class="nav-tail mono">{{ store.environmentIdentities.length }}</span>
      </button>
      <button
        type="button"
        class="nav-item"
        :class="{ active: view === 'scenes' }"
        @click="emit('navigate', 'scenes')"
      >
        <Layers :size="14" />
        <span>{{ $t("app.scenes") }}</span>
        <span class="nav-tail mono">{{ activeSceneCount }}</span>
      </button>
      <button
        type="button"
        class="nav-item"
        :class="{ active: view === 'settings' }"
        @click="emit('navigate', 'settings')"
      >
        <Monitor :size="14" />
        <span>{{ $t("app.engines") }}</span>
        <span class="nav-tail mono">{{ store.engines.length }}</span>
      </button>
    </nav>

    <div class="rail-sep"></div>

    <div class="rail-head">
      <span class="rail-title">{{ $t("app.railScenes") }}</span>
      <button
        class="tool"
        type="button"
        :aria-label="$t('app.newScene')"
        :title="$t('app.newScene')"
        @click="emit('newScene')"
      >
        <Plus :size="12" />
      </button>
    </div>

    <div class="scene-list">
      <button
        v-for="scene in store.environmentScenes.slice(0, 6)"
        :key="scene.id"
        type="button"
        class="scene-item"
        @click="store.launchScene(scene.id)"
      >
        <Play :size="11" class="scene-play" />
        <span class="scene-name">{{ scene.name }}</span>
        <span class="scene-count mono">{{ scene.identityIds.length }}</span>
      </button>
      <span v-if="!store.environmentScenes.length" class="scene-empty">{{ $t("app.noScenesYet") }}</span>
    </div>

    <div class="rail-foot">
      <button class="engine-row" type="button" @click="emit('navigate', 'settings')">
        <Settings2 :size="12" />
        <span>{{ $t("app.enginesLabel") }}</span>
        <span class="led" :class="{ idle: !store.defaultEngine }"></span>
        <span class="tail mono">{{ store.engines.length }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  border-right: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--bg) 92%, black);
  padding: 12px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: hidden;
}

.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 8px 5px;
}

.rail-title {
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--faint);
}

.rail-tools {
  display: flex;
  gap: 2px;
}

.tool {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
}

.tool:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.env-list,
.scene-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rail-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--muted);
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.rail-item:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.rail-item.active {
  background: var(--surface-3);
  border-color: var(--line);
  color: var(--text);
}

.env-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex: 0 0 7px;
}

.env-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-kind {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0.06em;
}

.empty-env {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 7px 8px;
  color: var(--faint);
  font-size: 11.5px;
  justify-content: center;
}

.empty-env:hover {
  color: var(--text-secondary);
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
}

.rail-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 4px 0;
  padding: 4px 6px;
  border-radius: 4px;
  color: var(--faint);
  font-size: 11.5px;
  text-align: left;
}

.rail-sub:hover {
  color: var(--text-secondary);
  background: var(--surface-2);
}

.rail-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 8px 6px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  color: var(--muted);
  font-size: 12.5px;
  text-align: left;
}

.nav-item:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.nav-item.active {
  background: var(--surface-3);
  border-color: var(--line);
  color: var(--text);
}

.nav-tail {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
}

.scene-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.scene-item:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.scene-play {
  color: var(--accent);
  flex: 0 0 11px;
}

.scene-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 5px;
  flex: 0 0 auto;
}

.scene-empty {
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--faint);
}

.rail-foot {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}

.engine-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--line-soft);
  background: var(--surface);
  text-align: left;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.engine-row:hover {
  border-color: var(--line);
  background: var(--surface-2);
}

.led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  margin-left: auto;
}

.led.idle {
  background: var(--faint);
}

.tail {
  font-size: 11px;
  color: var(--faint);
}
</style>
