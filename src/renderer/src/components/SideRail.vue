<script setup lang="ts">
import { Layers, Settings2, Users } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

defineProps<{ view: "identities" | "scenes" | "settings" }>();
const emit = defineEmits<{
  navigate: [view: "identities" | "scenes" | "settings"];
}>();

const store = useWorkspaceStore();
</script>

<template>
  <aside class="rail">
    <nav class="nav">
      <button
        type="button"
        data-nav="identities"
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
        data-nav="scenes"
        class="nav-item"
        :class="{ active: view === 'scenes' }"
        @click="emit('navigate', 'scenes')"
      >
        <Layers :size="14" />
        <span>{{ $t("app.scenes") }}</span>
        <span class="nav-tail mono">{{ store.environmentScenes.length }}</span>
      </button>
      <button
        type="button"
        data-nav="settings"
        class="nav-item"
        :class="{ active: view === 'settings' }"
        @click="emit('navigate', 'settings')"
      >
        <Settings2 :size="14" />
        <span>{{ $t("app.settings") }}</span>
      </button>
    </nav>

    <div class="rail-foot">
      <span class="foot-label">{{ $t("app.railEnvironment") }}</span>
      <span class="foot-env">
        <span class="dot"></span>
        <span class="foot-name">{{ store.activeEnvironment?.name ?? $t("app.notConfiguredEnv") }}</span>
      </span>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  border-right: 1px solid var(--line-soft);
  background: var(--bg);
  padding: 14px 9px 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
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

.rail-foot {
  margin-top: auto;
  padding: 10px 8px 0;
  border-top: 1px solid var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.foot-label {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
}

.foot-env {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 6px;
}

.foot-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
