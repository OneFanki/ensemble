<script setup lang="ts">
import { computed, ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Settings2 } from "lucide-vue-next";
import Logo from "./Logo.vue";
import { useWorkspaceStore } from "../stores/workspace";
import { isProductionName } from "@shared/environments";

defineProps<{ view: "environments" | "identities" | "scenes" | "settings" }>();
const emit = defineEmits<{ manageEnvironments: [] }>();

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

const isProd = computed(() => isProductionName(store.activeEnvironment?.name));

function choose(id: string) {
  store.setActiveEnvironment(id);
  open.value = false;
}

function manage() {
  open.value = false;
  emit("manageEnvironments");
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
        <span class="dot" :class="{ prod: isProd }"></span>
        <span class="env-name">{{ store.activeEnvironment?.name ?? $t("app.notConfiguredEnv") }}</span>
        <ChevronDown :size="11" class="chevron" :class="{ flip: open }" />
      </button>

      <div v-if="open" class="env-menu" role="listbox">
        <p class="menu-title">{{ $t("app.switchEnvironment") }}</p>
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
          <span class="dot" :class="{ prod: isProductionName(env.name) }"></span>
          <span class="menu-copy">
            <span class="menu-name">{{ env.name }}</span>
            <span class="menu-url mono">{{ env.baseUrl }}</span>
          </span>
          <Check v-if="env.id === store.activeEnvironment?.id" :size="12" class="check" />
        </button>
        <p v-if="!store.environments.length" class="menu-empty">{{ $t("app.emptyEnvironments") }}</p>

        <div class="menu-sep"></div>
        <button type="button" class="menu-action" @click="manage">
          <Settings2 :size="12" />
          {{ $t("app.manageEnvironments") }}
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
  padding: 2px 4px;
  line-height: 1.2;
}

.env-switcher {
  position: relative;
  display: flex;
  align-items: center;
  height: 30px;
}

/*
 * Every child is a flex item with line-height: 1 and the same vertical center.
 * The previous version mixed line-heights (`env-name` inherited 1.5 while the
 * badge had its own size), which made the row look a few pixels off-center even
 * though the box itself was centered.
 */
.env-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  line-height: 1;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 0 9px;
  font-size: 11.5px;
  color: var(--text-secondary);
  max-width: 360px;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.env-switch:hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  background: var(--surface-2);
}

.env-switch .dot,
.menu-item .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
  align-self: center;
  background: var(--accent);
}

.env-switch .dot.prod,
.menu-item .dot.prod {
  background: var(--red);
}

.env-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
}

.chevron {
  flex: 0 0 auto;
  color: var(--faint);
  transition: transform 0.15s ease;
}

.chevron.flip {
  transform: rotate(180deg);
}

.env-menu {
  position: absolute;
  z-index: 71;
  top: calc(100% + 6px);
  left: 0;
  min-width: 288px;
  max-width: 380px;
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
  gap: 9px;
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

.menu-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.25;
}

.menu-url {
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  margin-left: auto;
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
  font-size: 12px;
  text-align: left;
}

.menu-action:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.prod-badge {
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 40%, var(--line));
  border-radius: 4px;
  padding: 2px 5px;
  line-height: 1.2;
}

.right {
  margin-left: auto;
  display: flex;
  align-items: center;
}

.engine-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 10.5px;
  color: var(--faint);
  max-width: 260px;
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
  flex: 0 0 5px;
}

.led.idle {
  background: var(--faint);
}
</style>
