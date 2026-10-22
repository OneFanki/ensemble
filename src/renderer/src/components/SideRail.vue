<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  Layers,
  Settings2,
  Users,
  Waypoints,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

const props = defineProps<{
  view: "browser" | "sites" | "identities" | "views" | "settings";
}>();
const emit = defineEmits<{
  navigate: [view: "browser" | "sites" | "identities" | "views" | "settings"];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();

/**
 * Collapsed by default: the browser page is the default page, and it needs the
 * width. The toggle in the footer is the only thing that expands it — hovering
 * must not resize the layout under the pointer. The same toggle collapses it
 * again, so the state is one boolean rather than a pin plus a hover.
 */
const expanded = ref(window.localStorage.getItem("ensemble.rail.expanded") === "1");
/** Site name shown above the footer summary, kept short for the narrow state. */
const activeSiteName = computed(() => store.activeSite?.name ?? t("app.notConfiguredSite"));

const runningCount = computed(() => embedded.tabs.length + store.instances.length);

function navigate(next: typeof props.view): void {
  emit("navigate", next);
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
  window.localStorage.setItem("ensemble.rail.expanded", expanded.value ? "1" : "0");
}

/** English needs a singular form; a bare `{count} views` reads wrong at 1. */
function countLabel(singularKey: string, pluralKey: string, count: number): string {
  return t(count === 1 ? singularKey : pluralKey, { count });
}
</script>

<template>
  <!--
    Every platform resource gets a nav row. Sites used to be reachable
    only through the title-bar switcher, which made newcomers wonder where the
    isolation boundary actually lived.
  -->
  <aside class="rail" :class="{ expanded }" data-tour="side-nav">
    <nav class="nav">
      <button
        type="button"
        data-nav="browser"
        class="nav-item"
        :class="{ active: view === 'browser' }"
        :aria-label="t('app.browser')"
        @click="navigate('browser')"
      >
        <Globe2 :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.browser") }}</span>
        <span v-if="runningCount" class="nav-tail mono">{{ runningCount }}</span>
        <span v-else-if="!expanded" class="nav-badge-dot"></span>
        <span v-if="!expanded" class="tip">{{ t("app.browser") }}</span>
      </button>
      <button
        type="button"
        data-nav="sites"
        class="nav-item"
        :class="{ active: view === 'sites' }"
        :aria-label="t('app.sites')"
        @click="navigate('sites')"
      >
        <Waypoints :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.sites") }}</span>
        <span class="nav-tail mono">{{ store.sites.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.sites") }}</span>
      </button>
      <button
        type="button"
        data-nav="identities"
        class="nav-item"
        :class="{ active: view === 'identities' }"
        :aria-label="t('app.identities')"
        @click="navigate('identities')"
      >
        <Users :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.identities") }}</span>
        <span class="nav-tail mono">{{ store.siteIdentities.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.identities") }}</span>
      </button>
      <button
        type="button"
        data-nav="views"
        class="nav-item"
        :class="{ active: view === 'views' }"
        :aria-label="t('app.views')"
        @click="navigate('views')"
      >
        <Layers :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.views") }}</span>
        <span class="nav-tail mono">{{ store.siteViews.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.views") }}</span>
      </button>
      <button
        type="button"
        data-nav="settings"
        class="nav-item"
        :class="{ active: view === 'settings' }"
        :aria-label="t('app.settings')"
        @click="navigate('settings')"
      >
        <Settings2 :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.settings") }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.settings") }}</span>
      </button>
    </nav>

    <div class="rail-foot">
      <template v-if="expanded">
        <span class="foot-label">{{ t("app.currentSite") }}</span>
        <span class="foot-site">
          <span class="dot"></span>
          <span class="foot-name">{{ activeSiteName }}</span>
        </span>
        <span class="foot-url mono" :title="store.activeSite?.baseUrl">
          {{ store.activeSite?.baseUrl ?? "—" }}
        </span>
        <span class="foot-counts mono">
          {{
            countLabel("app.identityCountOne", "app.identityCount", store.siteIdentities.length)
          }}
          ·
          {{ countLabel("app.viewCountOne", "app.viewCount", store.siteViews.length) }}
        </span>
      </template>
      <button
        type="button"
        class="rail-toggle"
        :aria-label="expanded ? t('app.railCollapse') : t('app.railExpand')"
        :aria-expanded="expanded"
        @click="toggleExpanded"
      >
        <ChevronLeft v-if="expanded" :size="14" />
        <ChevronRight v-else :size="14" />
        <span v-if="!expanded" class="tip">{{ t("app.railExpand") }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  border-right: 1px solid var(--line-soft);
  background: var(--bg);
  width: 52px;
  padding: 12px 6px 10px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  transition: width 0.16s ease;
  flex: 0 0 auto;
}

.rail.expanded {
  width: var(--rail-width);
  padding: 14px 9px 12px;
}

/*
 * The tooltip has to escape the rail, so the collapsed rail stops clipping.
 * The expanded rail never shows one, so it can keep clipping its own content.
 */
.rail:not(.expanded) {
  overflow: visible;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  color: var(--muted);
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
}

.rail:not(.expanded) .nav-item {
  justify-content: center;
  padding: 9px 4px;
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

.nav-icon {
  flex: none;
}

.nav-label,
.nav-tail {
  display: none;
}

.rail.expanded .nav-label,
.rail.expanded .nav-tail {
  display: inline;
}

.nav-tail {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
}

.nav-badge-dot {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
}

/* Custom tooltip: native `title` is slow and does not match the theme. */
.tip {
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%) translateX(-3px);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgb(0 0 0 / 40%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
  z-index: 60;
}

.nav-item:hover .tip,
.rail-toggle:hover .tip {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.rail-foot {
  position: relative;
  margin-top: auto;
  padding: 10px 4px 0;
  border-top: 1px solid var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  align-items: center;
}

.rail.expanded .rail-foot {
  padding: 10px 8px 0;
  align-items: stretch;
}

.rail-toggle {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 28px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}

.rail:not(.expanded) .rail-toggle {
  width: 30px;
  height: 30px;
}

.rail-toggle:hover {
  color: var(--text-secondary);
  background: var(--surface-2);
  border-color: var(--line);
}

.foot-label {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
  margin-top: 12px;
}

.foot-site {
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

.foot-url {
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot-counts {
  font-size: 10px;
  color: var(--faint);
}

</style>
