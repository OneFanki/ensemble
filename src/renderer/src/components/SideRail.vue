<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  Layers,
  ListChecks,
  Settings2,
  Tag,
  Users,
  Waypoints,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

type RailView = "browser" | "sites" | "identities" | "views" | "flows" | "tags" | "settings";

const props = defineProps<{
  view: RailView;
}>();
const emit = defineEmits<{
  navigate: [view: RailView];
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
const runningCount = computed(() => embedded.tabs.length + store.instances.length);
const tags = computed(() => store.snapshot?.tags ?? []);

function navigate(next: typeof props.view): void {
  emit("navigate", next);
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
  window.localStorage.setItem("ensemble.rail.expanded", expanded.value ? "1" : "0");
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
        <span class="nav-tail mono">{{ store.identities.length }}</span>
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
        <span class="nav-tail mono">{{ store.views.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.views") }}</span>
      </button>
      <button
        type="button"
        data-nav="flows"
        class="nav-item"
        :class="{ active: view === 'flows' }"
        :aria-label="t('app.flows')"
        @click="navigate('flows')"
      >
        <ListChecks :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.flows") }}</span>
        <span class="nav-tail mono">{{ store.flows.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.flows") }}</span>
      </button>
      <button
        type="button"
        data-nav="tags"
        class="nav-item"
        :class="{ active: view === 'tags' }"
        :aria-label="t('app.tags')"
        @click="navigate('tags')"
      >
        <Tag :size="15" class="nav-icon" />
        <span class="nav-label">{{ t("app.tags") }}</span>
        <span class="nav-tail mono">{{ tags.length }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.tags") }}</span>
      </button>
    </nav>

    <!--
      Settings is not a resource like the pages above: it is where you go to
      change the app, not where you keep things. Pinning it to the bottom keeps
      it out of the working set and leaves the nav column for what you use.
    -->
    <div class="rail-foot">
      <button
        type="button"
        data-nav="settings"
        class="nav-item"
        :class="{ active: view === 'settings' }"
        :aria-label="t('app.settings')"
        @click="navigate('settings')"
      >
        <Settings2 :size="15" class="nav-icon" />
        <span class="nav-label">{{ t('app.settings') }}</span>
        <span v-if="!expanded" class="tip">{{ t("app.settings") }}</span>
      </button>
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

</style>
