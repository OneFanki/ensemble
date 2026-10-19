<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown, Minus, Settings2, Square, X } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

defineProps<{ view: "identities" | "scenes" | "settings" }>();
const emit = defineEmits<{
  openSettings: [];
  openEnvironment: [];
  newEnvironment: [];
}>();

const store = useWorkspaceStore();

const platform = computed(() => store.snapshot?.platform ?? "win32");
const engineLabel = computed(() => {
  const engine = store.defaultEngine;
  if (!engine) return "未发现浏览器";
  return `${engine.brand} ${engine.version ?? ""}`.trim();
});
const kindLabel = computed(() => {
  const kind = store.activeEnvironment?.kind;
  return kind === "prod" ? "PROD" : kind === "staging" ? "STG" : "LOCAL";
});
</script>

<template>
  <header class="titlebar drag-region" :data-platform="platform">
    <div class="brand no-drag">
      <span class="mark">e</span>
      <span class="name">Ensemble</span>
      <span class="version mono">0.1</span>
    </div>

    <button class="env-switch no-drag" type="button" @click="emit('openEnvironment')">
      <span class="dot" :class="store.activeEnvironment?.kind"></span>
      <span class="env-name">{{ store.activeEnvironment?.name ?? "未配置环境" }}</span>
      <span class="env-kind mono">{{ store.activeEnvironment ? kindLabel : "—" }}</span>
      <ChevronDown :size="11" />
    </button>

    <span v-if="store.activeEnvironment?.kind === 'prod'" class="prod-badge no-drag mono">
      生产环境
    </span>

    <div class="right no-drag">
      <span class="engine-pill mono" :title="engineLabel">
        <span class="led" :class="{ idle: !store.defaultEngine }"></span>
        <span class="engine-label">{{ engineLabel }}</span>
      </span>
      <button
        class="icon-btn"
        type="button"
        :aria-label="$t('app.settings')"
        @click="emit('openSettings')"
      >
        <Settings2 :size="14" />
      </button>
      <div v-if="platform !== 'darwin'" class="window-buttons">
        <button
          class="win-btn"
          type="button"
          aria-label="最小化"
          @click="store.api.minimizeWindow()"
        >
          <Minus :size="12" />
        </button>
        <button
          class="win-btn"
          type="button"
          aria-label="最大化"
          @click="store.api.toggleMaximizeWindow()"
        >
          <Square :size="10" />
        </button>
        <button
          class="win-btn close"
          type="button"
          aria-label="关闭"
          @click="store.api.closeWindow()"
        >
          <X :size="12" />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--line-soft);
  background: linear-gradient(180deg, var(--surface), var(--bg-elevated));
  height: var(--titlebar-height);
}

.titlebar[data-platform="darwin"] {
  padding-left: 86px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.mark {
  width: 21px;
  height: 21px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, var(--accent-strong), color-mix(in srgb, var(--accent) 82%, black));
  color: var(--accent-foreground);
  font: 500 12px/1 var(--font-mono);
}

.version {
  font-size: 9.5px;
  color: var(--faint);
  letter-spacing: 0.06em;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 4px;
}

.env-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 5px 8px 5px 9px;
  font-size: 11.5px;
  color: var(--text-secondary);
  max-width: 320px;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.env-switch:hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  background: var(--surface-2);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 6px;
}

.dot.staging {
  background: var(--blue);
}

.dot.prod {
  background: var(--red);
}

.env-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-kind {
  color: var(--faint);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.prod-badge {
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 40%, var(--line));
  border-radius: 4px;
  padding: 3px 6px;
}

.right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.engine-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 8px;
  background: var(--surface);
  max-width: 220px;
}

.engine-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 7px color-mix(in srgb, var(--green) 70%, transparent);
  flex: 0 0 5px;
}

.led.idle {
  background: var(--faint);
  box-shadow: none;
}

.icon-btn {
  width: 28px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--muted);
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.window-buttons {
  display: flex;
  gap: 2px;
  margin-left: 4px;
}

.win-btn {
  width: 27px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--dim);
}

.win-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.win-btn.close:hover {
  background: #8f3030;
  color: #fff;
}
</style>
