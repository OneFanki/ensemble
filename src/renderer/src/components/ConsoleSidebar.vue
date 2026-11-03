<script setup lang="ts">
/**
 * The console's navigation, as a column on the left.
 *
 * The mockup (`docs/design/mockups/v2-shell/`) settles this: the console is a
 * full-window surface with its own rail, the way a desktop application's
 * preferences are. It was a second row of chrome across the top for one
 * revision — that reads as a website's sub-navigation, and the horizontal band
 * collided with the browser's own tab strip, so the two screens looked like the
 * same thing in two states.
 *
 * Entries are grouped: the workspace (the four kinds of asset plus bookmarks and
 * tag vocabulary) and the application (settings). The group captions are the
 * same words the rail used in 1.x, because they are what these things are, not
 * decoration.
 *
 * Icons come from the mockup's own vocabulary and are not free choices: a globe
 * for a site (an address you open), a workflow for flows (a chain of steps), a
 * gear for settings.
 */
import {
  Bookmark,
  Globe,
  LayoutGrid,
  Settings,
  Tag,
  Users,
  Workflow,
} from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";

type ConsoleView = "sites" | "identities" | "views" | "flows" | "tags" | "bookmarks" | "settings";

defineProps<{ view: string }>();
const emit = defineEmits<{
  navigate: [view: ConsoleView];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const tags = computed(() => store.snapshot?.tags ?? []);

const workspaceEntries = computed(() => [
  { view: "sites" as const, label: t("app.sites"), icon: Globe, count: store.sites.length },
  {
    view: "identities" as const,
    label: t("app.identities"),
    icon: Users,
    count: store.identities.length,
  },
  { view: "views" as const, label: t("app.views"), icon: LayoutGrid, count: store.views.length },
  { view: "flows" as const, label: t("app.flows"), icon: Workflow, count: store.flows.length },
  {
    view: "bookmarks" as const,
    label: t("app.bookmarks"),
    icon: Bookmark,
    count: store.bookmarks.length,
  },
  { view: "tags" as const, label: t("app.tags"), icon: Tag, count: tags.value.length },
]);

const appEntries = computed(() => [
  { view: "settings" as const, label: t("app.settings"), icon: Settings, count: 0 },
]);
</script>

<template>
  <nav class="console-nav" :aria-label="t('app.consoleNav')">
    <div class="nav-group">
      <p class="nav-title">{{ t("app.consoleGroupWorkspace") }}</p>
      <button
        v-for="entry in workspaceEntries"
        :key="entry.view"
        type="button"
        class="nav-item"
        :class="{ active: view === entry.view }"
        :aria-current="view === entry.view ? 'page' : undefined"
        :title="entry.label"
        :data-nav="entry.view"
        @click="emit('navigate', entry.view)"
      >
        <component :is="entry.icon" :size="14" class="nav-icon" />
        <span class="nav-label">{{ entry.label }}</span>
        <span v-if="entry.count" class="nav-count mono">{{ entry.count }}</span>
      </button>
    </div>

    <div class="nav-group">
      <p class="nav-title">{{ t("app.consoleGroupApp") }}</p>
      <button
        v-for="entry in appEntries"
        :key="entry.view"
        type="button"
        class="nav-item"
        :class="{ active: view === entry.view }"
        :aria-current="view === entry.view ? 'page' : undefined"
        :title="entry.label"
        :data-nav="entry.view"
        @click="emit('navigate', entry.view)"
      >
        <component :is="entry.icon" :size="14" class="nav-icon" />
        <span class="nav-label">{{ entry.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
/*
 * Geometry from the mockup: 196px wide, 12px/9px padding, 31px rows, 1px gaps.
 * `--rail-width` is already 196 in tokens, so this is the same width the 1.x
 * side rail used — the console has had a column here before and it fits.
 */
.console-nav {
  flex: 0 0 var(--rail-width);
  width: var(--rail-width);
  padding: var(--space-5) 9px;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  background: var(--frame);
  overflow-y: auto;
  scrollbar-width: thin;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* Group captions are structure, not items: small, muted, and not clickable. */
.nav-title {
  margin: 0;
  padding: var(--space-3) 10px var(--space-3);
  font-size: var(--fs-2xs);
  letter-spacing: 0.03em;
  color: var(--faint);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 31px;
  padding: 0 10px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--fs-base);
  text-align: left;
  min-width: 0;
}

.nav-item:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
}

/* The selected row is the chrome surface — the same fill an active browser tab
   uses, which is what makes the rail and the page read as one window. */
.nav-item.active {
  background: var(--chrome);
  color: var(--text);
}

.nav-item.active .nav-icon {
  color: var(--accent);
}

.nav-icon {
  flex: 0 0 14px;
}

.nav-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-count {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.nav-item.active .nav-count {
  color: var(--muted);
}

/*
 * Below 1000px the rail narrows to its icons.
 *
 * The window minimum is 960px: at that size a 196px rail would leave the page
 * 764px, which is still usable but cramped for a three-column card grid. A 46px
 * rail — the same width the dock collapses to — keeps the destinations one click
 * away instead of hiding the navigation entirely.
 */
@media (max-width: 1000px) {
  .console-nav {
    flex-basis: 46px;
    width: 46px;
    padding: var(--space-5) 6px;
    align-items: center;
  }

  .nav-title,
  .nav-label,
  .nav-count {
    display: none;
  }

  .nav-item {
    justify-content: center;
    width: 34px;
    padding: 0;
  }
}
</style>
