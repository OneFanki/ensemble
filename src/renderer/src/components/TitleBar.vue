<script setup lang="ts">
import { computed, ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Pencil, Plus } from "lucide-vue-next";
import Logo from "./Logo.vue";
import { useWorkspaceStore } from "../stores/workspace";
import { environmentBadge, environmentTone, isProductionKind } from "@shared/environments";

defineProps<{ view: "identities" | "scenes" | "settings" }>();
const emit = defineEmits<{
  openEnvironment: [];
  newEnvironment: [];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const platform = computed(() => store.snapshot?.platform ?? "win32");
const open = ref(false);
const switcher = ref<HTMLElement | null>(null);

onClickOutside(switcher, () => {
  open.value = false;
});

const engineLabel = computed(() => {
  if (!store.enginesReady) return t("app.scanningEngines");
  const engine = store.defaultEngine;
  if (!engine) return t("app.noBrowserFound");
  return `${engine.brand} ${engine.version ?? ""}`.trim();
});

const activeKind = computed(() => store.activeEnvironment?.kind);
const activeBadge = computed(() => environmentBadge(activeKind.value));
const activeTone = computed(() => environmentTone(activeKind.value));
const isProd = computed(() => isProductionKind(activeKind.value));

function toneColor(tone: "red" | "blue" | "accent"): string {
  if (tone === "red") return "var(--red)";
  if (tone === "blue") return "var(--blue)";
  return "var(--accent)";
}

function choose(id: string) {
  store.setActiveEnvironment(id);
  open.value = false;
}

function createEnvironment() {
  open.value = false;
  emit("newEnvironment");
}

function editEnvironment() {
  open.value = false;
  emit("openEnvironment");
}
</script>

<template>
  <header class="titlebar drag-region" :data-platform="platform">
    <div class="brand no-drag">
      <Logo :size="22" />
      <span class="name">Ensemble</span>
      <span class="version mono">0.1</span>
    </div>

    <div ref="switcher" class="env-switcher no-drag">
      <button
        class="env-switch"
        type="button"
        :aria-expanded="open"
        aria-haspopup="listbox"
        @click="open = !open"
      >
        <span class="dot" :style="{ background: toneColor(activeTone) }"></span>
        <span class="env-name">{{ store.activeEnvironment?.name ?? $t("app.notConfiguredEnv") }}</span>
        <span class="env-kind mono">{{ activeBadge }}</span>
        <ChevronDown :size="11" :class="{ flip: open }" />
      </button>

      <div v-if="open" class="env-menu" role="listbox">
        <p class="menu-title">{{ $t("app.railEnvironment") }}</p>
        <button
          v-for="env in store.environments"
          :key="env.id"
          type="button"
          role="option"
          class="menu-item"
          :class="{ active: env.id === store.activeEnvironment?.id }"
          :aria-selected="env.id === store.activeEnvironment?.id"
          @click="choose(env.id)"
        >
          <span class="dot" :style="{ background: toneColor(environmentTone(env.kind)) }"></span>
          <span class="menu-name">{{ env.name }}</span>
          <span class="menu-kind mono">{{ environmentBadge(env.kind) }}</span>
          <Check v-if="env.id === store.activeEnvironment?.id" :size="12" class="check" />
        </button>
        <p v-if="!store.environments.length" class="menu-empty">{{ $t("app.moduleNotReady") }}</p>

        <div class="menu-sep"></div>
        <button type="button" class="menu-action" @click="createEnvironment">
          <Plus :size="12" />
          {{ $t("app.newEnvironment") }}
        </button>
        <button
          v-if="store.activeEnvironment"
          type="button"
          class="menu-action"
          @click="editEnvironment"
        >
          <Pencil :size="12" />
          {{ $t("app.editEnvironment") }}
        </button>
      </div>
    </div>

    <span v-if="isProd" class="prod-badge no-drag mono">{{ $t("app.prod") }}</span>

    <div class="right no-drag">
      <span class="engine-pill mono" :title="engineLabel">
        <span class="led" :class="{ idle: !store.enginesReady || !store.defaultEngine }"></span>
        <span class="engine-label">{{ engineLabel }}</span>
      </span>
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
  background: var(--surface);
  height: var(--titlebar-height);
}

/* Leave room for the native window-controls overlay. */
.titlebar[data-platform="win32"],
.titlebar[data-platform="linux"] {
  padding-right: 146px;
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

.version {
  font-size: 10px;
  color: var(--dim);
  letter-spacing: 0.06em;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 4px;
}

.env-switcher {
  position: relative;
}

.env-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 0 9px;
  font-size: 11.5px;
  color: var(--text-secondary);
  max-width: 340px;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.env-switch:hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  background: var(--surface-2);
}

.env-switch svg {
  flex: 0 0 auto;
  color: var(--faint);
  transition: transform 0.15s ease;
}

.env-switch svg.flip {
  transform: rotate(180deg);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
}

.env-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-kind {
  color: var(--faint);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  flex: 0 0 auto;
}

.env-menu {
  position: absolute;
  z-index: 71;
  top: calc(100% + 6px);
  left: 0;
  min-width: 268px;
  max-width: 340px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 14px 34px rgb(0 0 0 / 45%);
  padding: 6px;
}

.menu-title {
  margin: 2px 8px 6px;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12px;
  text-align: left;
}

.menu-item:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.menu-item.active {
  background: var(--surface-3);
  color: var(--text);
}

.menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-kind {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
  letter-spacing: 0.06em;
}

.menu-item.active .menu-kind {
  color: var(--text-secondary);
}

.check {
  color: var(--accent);
  flex: 0 0 12px;
}

.menu-empty {
  margin: 4px 8px 8px;
  font-size: 11.5px;
  color: var(--faint);
}

.menu-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 6px 4px;
}

.menu-action {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.menu-action:hover {
  background: var(--surface-2);
  color: var(--text);
}

.prod-badge {
  font-size: 10.5px;
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
  font-size: 11.5px;
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
</style>
