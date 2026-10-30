<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import { AppWindow, BookOpen, Check, ChevronDown, Monitor, ShieldOff } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import { guideIsUnread } from "../onboarding/guide";
import Logo from "./Logo.vue";

const emit = defineEmits<{ menuOpen: [boolean]; openGuide: [] }>();

const store = useWorkspaceStore();
const { t } = useI18n();

const platform = computed(() => store.snapshot?.platform ?? "win32");
const launchOpen = ref(false);
const launchSwitcher = ref<HTMLElement | null>(null);

/**
 * Whether to mark the guide as unread.
 *
 * A stored version number, not a timestamp: "have they seen the current guide"
 * is the actual question, and re-reading it should not require a new flag.
 * Bumping the guide's version is what re-lights the dot after a real change.
 */
const guideUnread = computed(() => guideIsUnread(store.settings));

onClickOutside(launchSwitcher, () => {
  launchOpen.value = false;
});

// A dropdown in the title bar extends over the browser stage, where the native
// pages would paint on top of it. The browser page freezes its stage while this
// is true so the menu stays readable.
watch(launchOpen, (value) => emit("menuOpen", value));

const engineLabel = computed(() => {
  if (!store.enginesReady) return t("app.scanningEngines");
  const engine = store.defaultEngine;
  if (!engine) return t("app.noBrowserFound");
  return `${engine.brand} ${engine.version ?? ""}`.trim();
});

const launchTarget = computed(() => store.settings.launchTarget ?? "embedded");

const launchOptions = computed(() => [
  {
    value: "embedded" as const,
    label: t("app.launchTargetEmbedded"),
    hint: t("app.launchTargetEmbeddedHint"),
    icon: AppWindow,
  },
  {
    value: "external" as const,
    label: t("app.launchTargetExternal"),
    hint: engineLabel.value,
    icon: Monitor,
  },
]);

const launchLabel = computed(
  () =>
    launchOptions.value.find((option) => option.value === launchTarget.value)?.label ??
    t("app.launchTargetEmbedded"),
);

function chooseLaunch(value: "embedded" | "external"): void {
  launchOpen.value = false;
  if (value === launchTarget.value) return;
  void store.saveSettings({ launchTarget: value });
}

/**
 * Opens a throwaway session on the surface chosen above.
 *
 * It lives in this menu because it is the same decision: the switch says where
 * launches go, and a clean session is a launch. Keeping it here also means there
 * is exactly one place to look — it used to be a button on three different pages,
 * each of which ignored the switch and opened the external browser.
 */
async function openClean(): Promise<void> {
  launchOpen.value = false;
  await store.openCleanSession();
}
</script>

<template>
  <header class="titlebar drag-region" :data-platform="platform">
    <div class="brand no-drag" data-tour="brand">
      <Logo :size="22" />
      <span class="name">Ensemble</span>
    </div>

    <div class="right no-drag">
      <!-- The guide lives here rather than in the side rail: the rail is a list
           of things you work *with*, and help is not one of them. Top right is
           where people look for it, and the dot is the only thing that says
           "there is something to read" without interrupting. -->
      <button
        type="button"
        class="guide-button"
        :class="{ unread: guideUnread }"
        :aria-label="$t('app.guideOpen')"
        :title="$t('app.guideOpen')"
        @click="emit('openGuide')"
      >
        <BookOpen :size="14" />
        <span v-if="guideUnread" class="guide-dot" aria-hidden="true"></span>
      </button>

      <!-- One switch decides where every launch goes. Adding a second button to
           each management page made the same action look like two features. -->
      <div ref="launchSwitcher" class="launch-switcher" data-tour="launch-target">
        <button
          type="button"
          class="launch-switch"
          :aria-expanded="launchOpen"
          aria-haspopup="listbox"
          :title="$t('app.launchTargetHint')"
          @click="launchOpen = !launchOpen"
        >
          <AppWindow v-if="launchTarget === 'embedded'" :size="13" />
          <Monitor v-else :size="13" />
          <span class="launch-label">{{ launchLabel }}</span>
          <ChevronDown :size="11" class="chevron" :class="{ flip: launchOpen }" />
        </button>

        <div v-if="launchOpen" class="launch-menu" role="listbox">
          <p class="menu-title">{{ $t("app.launchTargetTitle") }}</p>
          <button
            v-for="option in launchOptions"
            :key="option.value"
            type="button"
            role="option"
            class="menu-item"
            :class="{ active: option.value === launchTarget }"
            :aria-selected="option.value === launchTarget"
            @click="chooseLaunch(option.value)"
          >
            <component :is="option.icon" :size="13" class="launch-icon" />
            <span class="menu-copy">
              <span class="menu-name">{{ option.label }}</span>
              <span class="menu-url">{{ option.hint }}</span>
            </span>
            <Check v-if="option.value === launchTarget" :size="12" class="check" />
          </button>
          <!-- A clean session is a launch, so it belongs in the launch menu. The
               hint names the current surface so the outcome is predictable. -->
          <button type="button" class="menu-item clean" @click="openClean">
            <ShieldOff :size="13" class="launch-icon" />
            <span class="menu-copy">
              <span class="menu-name">{{ $t("app.cleanSession") }}</span>
              <span class="menu-url">
                {{
                  launchTarget === "embedded"
                    ? $t("app.cleanSessionInEmbedded")
                    : $t("app.cleanSessionInExternal")
                }}
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  position: relative;
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

.menu-item .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
  align-self: center;
  background: var(--accent);
}

.chevron {
  flex: 0 0 auto;
  color: var(--faint);
  transition: transform 0.15s ease;
}

.chevron.flip {
  transform: rotate(180deg);
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

/* Separated from the two surface choices: those pick a destination, this one
   performs a launch there. A divider is the whole difference. */
.menu-item.clean {
  margin-top: 3px;
  padding-top: 9px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
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

.right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Same vocabulary as .launch-switch beside it: a quiet square the icon centers
   in. Without these rules the button renders native — the uncentered icon the
   title bar shipped with for a while. */
.guide-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.guide-button:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* Unread mark, not a count: a dot on the corner that clears once opened. */
.guide-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.launch-switcher {
  position: relative;
  z-index: 6;
}

.launch-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0 9px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.launch-switch:hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  background: var(--surface-2);
  color: var(--text);
}

.launch-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.launch-menu {
  position: absolute;
  z-index: 71;
  top: calc(100% + 6px);
  right: 0;
  min-width: 240px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  padding: 6px;
}

.launch-icon {
  color: var(--faint);
  flex: 0 0 13px;
}
</style>
