<script setup lang="ts">
import type { Identity, RoleColor, Site, SiteGroup } from "@shared/types";
import {
  Check,
  CheckSquare,
  Download,
  Globe,
  GripVertical,
  HeartPulse,
  LayoutGrid,
  Link2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Tags,
  Users,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useGroupCollapse } from "../composables/useGroupCollapse";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import GroupCollapseAll from "./GroupCollapseAll.vue";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import SiteGroupsEditor from "./SiteGroupsEditor.vue";
import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import FormField from "./ui/FormField.vue";
import IconButton from "./ui/IconButton.vue";
import LaunchSplitButton from "./ui/LaunchSplitButton.vue";
import TextField from "./ui/TextField.vue";
import GroupHeader from "./ui/GroupHeader.vue";

const emit = defineEmits<{
  newSite: [];
  editSite: [siteId: string];
  newIdentity: [siteId?: string];
  editIdentity: [id: string];
  sessionHealth: [];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();
const filter = ref<"all" | "running" | "expired">("all");
const query = ref("");
/**
 * Which of the page's two faces is showing.
 *
 * `use` (the default) answers one question: "which account do I open now". It
 * shows tiles — avatar, name, one status dot — and a click launches. That is what
 * this page is for almost every time it is opened, and a row table was the wrong
 * shape for it: a table is for reading rows field by field, which is what
 * *changing* accounts needs.
 *
 * `edit` is the low-frequency face: rows with every field, per-row actions,
 * selection for bulk work, and the only place sites and groups are rearranged.
 * Everything that writes lives here, so the tile face stays clickable without
 * "was that the row I meant to edit?" mistakes.
 *
 * The state is remembered for the session only: opening the pane always starts on
 * `use`, because arriving at a management table when you meant to open an account
 * is the failure this split exists to prevent.
 */
const mode = ref<"use" | "edit">("use");
/**
 * Selection mode. The rows are buttons that launch (or open) on click, so
 * launching a handful one by one means every new browser window covers the next
 * row. In this mode a click toggles a checkbox instead, and one action launches
 * the whole selection into a single layout.
 */
const selecting = ref(false);
const selected = ref<Set<string>>(new Set());

const groupCollapse = useGroupCollapse("ensemble.groups.identities");

/**
 * Accounts "全选可见" reaches.
 *
 * A folded group's cards are not on screen, so counting them as visible would
 * make the label lie: the button says "select visible" and the user cannot see
 * what it picked. Accounts picked while their group was open stay picked — the
 * selection set is independent of what is drawn.
 */
const selectableIdentities = computed(() =>
  visibleIdentities.value.filter(
    (identity) =>
      !groupCollapse.isCollapsed(
        store.sites.some((site) => site.id === identity.siteId)
          ? (identity.siteId as string)
          : "__orphan__",
      ),
  ),
);

const allSelected = computed(
  () =>
    selectableIdentities.value.length > 0 &&
    selectableIdentities.value.every((identity) => selected.value.has(identity.id)),
);

const notRunningSelected = computed(() =>
  visibleIdentities.value.filter(
    (identity) => selected.value.has(identity.id) && !store.instanceFor(identity.id),
  ),
);

function toggleSelected(identityId: string) {
  // A new Set per change: Vue cannot see mutations of the same Set object.
  const next = new Set(selected.value);
  if (next.has(identityId)) next.delete(identityId);
  else next.add(identityId);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(selectableIdentities.value.map((identity) => identity.id));
}

function startSelecting() {
  selecting.value = true;
}

function endSelecting() {
  selecting.value = false;
  selected.value = new Set();
}

async function launchSelected() {
  const ids = notRunningSelected.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  // A batch is the one launch that is about a layout, so it gets its own
  // container instead of scattering pages into the tab strip.
  await embedded.openIdentitiesInNewView(ids);
  endSelecting();
}

/**
 * The same selection, tiled across real windows.
 *
 * A batch external launch is a fidelity check of an arrangement, so it uses the
 * workspace layout and the same tiling a saved view would — otherwise "compare
 * these six in an external browser" would open six stacked windows.
 */
async function launchSelectedExternal(engineId: string) {
  const ids = notRunningSelected.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  await store.launchIdentities(ids, engineId);
  endSelecting();
}

/**
 * Turns the selection into a saved view.
 *
 * Launching a batch already opens a container, but that container is scratch:
 * it is named by the surface and gone from the workspace once closed. The
 * question after picking six accounts is often "this is the group I keep coming
 * back to" — so the selection also routes into the view form, where it gets a
 * name, a layout and a place in the views page.
 */
/** Site choices for the batch re-link dialog. */
const siteOptions = computed(() =>
  store.sites.map((site) => ({
    value: site.id,
    label: site.name,
    hint: site.baseUrl,
  })),
);

/** The site picked in the link dialog, before it is confirmed. */
const linkSiteId = ref<string | undefined>(undefined);
const linkOpen = ref(false);

function openLinkSite() {
  if (selected.value.size === 0) return;
  // Default to the site most of the selection already belongs to, so the common
  // case (fixing one or two strays) needs no choice at all.
  const counts = new Map<string, number>();
  for (const identity of store.identities) {
    if (!selected.value.has(identity.id) || !identity.siteId) continue;
    counts.set(identity.siteId, (counts.get(identity.siteId) ?? 0) + 1);
  }
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  linkSiteId.value = majority ?? store.defaultSite?.id;
  linkOpen.value = true;
}

/**
 * Points every selected account at the confirmed site.
 *
 * Confirmation is the point of the dialog: this write moves credentials' home
 * site for a whole batch, and an accidental click on a dropdown row was one
 * stray pointer away from doing it silently.
 */
async function confirmLinkSite() {
  const siteId = linkSiteId.value;
  if (!siteId || selected.value.size === 0) return;
  const result = await store.linkIdentitiesToSite([...selected.value], siteId);
  if (!result) return;
  linkOpen.value = false;
  endSelecting();
}

const roleVar = (color: RoleColor) => `var(--role-${color})`;

/*
 * Sharing the selected accounts with a colleague.
 *
 * This is not the settings → Data export: that one migrates the whole workspace
 * (sites, views, layouts, ids). Here the point is "these three tenant logins",
 * so the selection is the payload and the receiver matches them by URL and
 * username in their own workspace.
 */
const exportOpen = ref(false);
const exportPassphrase = ref("");
const exportError = ref("");
const exporting = ref(false);

function openExport(): void {
  exportError.value = "";
  exportOpen.value = true;
}

async function doExport(): Promise<void> {
  exportError.value = "";
  const passphrase = exportPassphrase.value;
  if (passphrase && passphrase.length < 8) {
    exportError.value = t("app.accountsExportPassTooShort");
    return;
  }
  exporting.value = true;
  try {
    const ids = [...selected.value];
    // Sites are derived from the accounts, so the receiver gets somewhere to
    // attach them without the sender having to pick sites separately.
    const result = await window.ensemble.exportAccounts({
      siteIds: [],
      identityIds: ids,
      ...(passphrase ? { passphrase } : {}),
    });
    if (result.canceled) return;
    store.notify(
      t("app.accountsExportDone", {
        accounts: result.counts?.accounts ?? ids.length,
        sites: result.counts?.sites ?? 0,
      }),
      "success",
    );
    exportOpen.value = false;
    exportPassphrase.value = "";
    endSelecting();
  } catch (error) {
    exportError.value = (error as Error).message;
  } finally {
    exporting.value = false;
  }
}

/** Site-group filter; `null` means every account. */
const groupFilter = ref<string | null>(null);
/** The inline group manager, closed until asked for. */
const groupsPanelOpen = ref(false);

/**
 * The search term, matched against accounts *and* their site.
 *
 * Account names repeat across sites — "管理员" exists on every system — so a
 * name-only search answers a question nobody asked ("which of these twelve
 * 管理员"). Matching the site name too makes "订单" narrow to that system's
 * accounts, which is how people actually remember where an account lives. Both
 * terms are tried together rather than being separate search modes: no one has to
 * decide which kind of search they are doing.
 */
const matchesTerm = (identity: Identity, term: string): boolean => {
  if (
    identity.name.toLowerCase().includes(term) ||
    identity.username.toLowerCase().includes(term) ||
    identity.role.toLowerCase().includes(term)
  ) {
    return true;
  }
  const site = store.sites.find((item) => item.id === identity.siteId);
  return Boolean(
    site &&
      (site.name.toLowerCase().includes(term) || site.baseUrl.toLowerCase().includes(term)),
  );
};

const visibleIdentities = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.identities.filter((identity) => {
    const running = Boolean(store.instanceFor(identity.id));
    if (filter.value === "running" && !running) return false;
    if (filter.value === "expired" && identity.status !== "expired") return false;
    if (groupFilter.value && !store.groupsForIdentity(identity).includes(groupFilter.value)) {
      return false;
    }
    if (!term) return true;
    return matchesTerm(identity, term);
  });
});

/**
 * One section per site, in stored site order.
 *
 * The section header is the site: name, address, account count, the groups it is
 * filed under, and the controls that edit or delete the site itself. A site with
 * no accounts still gets a section — that is how a freshly created site appears
 * before its first account exists, and hiding it would make "create a site" look
 * like it had failed.
 */
const groups = computed(() => {
  const result: Array<{
    siteId: string;
    name: string;
    url: string;
    site?: Site;
    siteGroups: SiteGroup[];
    people: Identity[];
    total: number;
  }> = [];
  for (const site of store.sites) {
    const people = visibleIdentities.value.filter((identity) => identity.siteId === site.id);
    const total = store.identities.filter((identity) => identity.siteId === site.id).length;
    // A filter or a search that excludes every account also removes the section,
    // but the group filter is about the site: a matching site keeps its place.
    const matchesGroup =
      !groupFilter.value || Boolean(site.tagIds?.includes(groupFilter.value));
    if (people.length === 0 && (termActive.value || filter.value !== "all" || !matchesGroup)) {
      continue;
    }
    result.push({
      siteId: site.id,
      name: site.name,
      url: site.baseUrl,
      site,
      siteGroups: store.siteGroups.filter((group) => site.tagIds?.includes(group.id)),
      people,
      total,
    });
  }
  const orphans = visibleIdentities.value.filter(
    (identity) => !store.sites.some((site) => site.id === identity.siteId),
  );
  if (orphans.length > 0) {
    result.push({
      siteId: "__orphan__",
      name: t("app.identityOrphanSite"),
      url: "",
      siteGroups: [],
      people: orphans,
      total: orphans.length,
    });
  }
  return result;
});

const termActive = computed(() => query.value.trim().length > 0);

const groupKeys = computed(() => groups.value.map((group) => group.siteId));
const allCollapsed = computed(() => groupCollapse.allCollapsed(groupKeys.value));

/** Groups that hold at least one site, so the filter never lists dead ends. */
const filterGroups = computed(() => store.siteGroups.filter((group) => store.sitesInGroup(group.id).length > 0));

const runningCount = computed(
  () => store.identities.filter((identity) => store.instanceFor(identity.id)).length,
);
const expiredCount = computed(
  () => store.identities.filter((identity) => identity.status === "expired").length,
);

const statusLabel = (identity: Identity): string => {
  if (store.instanceFor(identity.id)) return t("app.statusRunning");
  if (identity.status === "expired") return t("app.statusExpired");
  if (identity.status === "signed-in") return formatRelative(identity.lastCheckedAt);
  return t("app.statusUnchecked");
};

function formatRelative(iso?: string): string {
  if (!iso) return t("app.statusUnchecked");
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return t("app.justNow");
  if (minutes < 60) return t("app.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("app.hoursAgo", { count: hours });
  return t("app.daysAgo", { count: Math.floor(hours / 24) });
}

async function launch(identity: Identity) {
  if (selecting.value) {
    toggleSelected(identity.id);
    return;
  }
  await launchHere(identity);
}

/**
 * What a click on the row body does.
 *
 * Two meanings, chosen by what the row itself is: in selection mode it is a
 * checkbox, and otherwise it launches. It used to open the account form when the
 * account was not running — which put a low-frequency action (editing a saved
 * account) behind the row's only large target and pushed the frequent one
 * (opening the page) onto a small control at the far right. A list of accounts
 * exists to open them; editing is a maintenance act with its own pencil.
 *
 * A running account raises its window instead of opening a second page: there is
 * one page per account in the built-in surface, and asking for it again means
 * "bring me the one I have".
 */
function onCardClick(identity: Identity): void {
  if (selecting.value) {
    toggleSelected(identity.id);
    return;
  }
  launch(identity);
}

/**
 * The plain click: a page in the built-in surface.
 *
 * Built-in means "a new tab in the default tab strip", always — even when a view
 * is on stage or the account is already running somewhere. Clicking a card is a
 * request for that page, not an instruction to rearrange the stage; moving into
 * a view is the drag gesture or the view's own "add tab".
 *
 * The split control's arrow is the other half: it opens the browser list, so the
 * fidelity check is one click away instead of being a mode set somewhere else.
 */
async function launchHere(identity: Identity): Promise<void> {
  await embedded.openIdentity(identity.id);
}

/**
 * The same account in an external browser.
 *
 * External windows exist once per identity, so launching again raises the
 * running one rather than opening a second window that would fight it for the
 * same profile directory.
 */
async function launchExternal(identity: Identity, engineId: string): Promise<void> {
  if (selecting.value) return;
  const instance = store.instanceFor(identity.id);
  if (instance) {
    await store.focusInstance(instance.id);
    return;
  }
  await store.launchIdentity(identity.id, undefined, engineId);
}

async function relogin(identity: Identity) {
  const instance = store.instanceFor(identity.id);
  if (instance) {
    // Raising the window is not relogin: the fill has to be asked for.
    await store.fillLogin(identity.id);
    return;
  }
  // The embedded surface has no login page to submit; opening the identity's
  // start page and filling it is the equivalent action, and it is the surface
  // the card's own click opens, so "重新登录" follows it.
  await embedded.openIdentity(identity.id);
}

async function checkAuth(identity: Identity) {
  await store.checkAuth(identity.id);
}

function passwordLabel(identity: Identity): string {
  if (identity.passwordMode === "reference") return t("app.passwordReferenced");
  if (!store.identityPasswordSet(identity)) return t("app.passwordNotSet");
  return identity.passwordMode === "custom" ? t("app.passwordCustom") : t("app.passwordInherit");
}

/**
 * The facts the card folds into "+N".
 *
 * Only things a user set on purpose: a browser that differs from the default,
 * and each extra login field by its label. The list is also the chip's tooltip,
 * so folding them never hides what they are — it only stops them from reflowing
 * the grid.
 */
function extraFacts(identity: Identity): string[] {
  const facts: string[] = [];
  const brand = identity.engineId ? store.engineFor(identity)?.brand : undefined;
  if (brand) facts.push(brand);
  for (const field of identity.extraFields ?? []) facts.push(field.label);
  return facts;
}

/* ------------------------------------------------------------------ */
/* Reordering, edit face only                                          */
/* ------------------------------------------------------------------ */

/*
 * Sites reorder by dragging a grip on their group heading.
 *
 * The grip rather than the whole heading: the heading is also a fold target and
 * carries two buttons, and a heading-wide drag swallows the first click of
 * "collapse" every time. Only the edit face draws the grip, because ordering is
 * maintenance — on the tile face a tile that both launches and starts a drag is
 * a tile that does the wrong thing half the time.
 *
 * Accounts deliberately do not reorder. Their order inside a site is the stored
 * array order and there is no `moveIdentity` behind it; a handle that did nothing
 * would be worse than no handle.
 */

const draggingSiteId = ref<string | null>(null);
/** The heading the pointer is over, which draws the insertion line. */
const dropSiteId = ref<string | null>(null);

function onSiteDragStart(siteId: string, event: DragEvent): void {
  draggingSiteId.value = siteId;
  event.dataTransfer?.setData("text/plain", siteId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onSiteDragOver(siteId: string, event: DragEvent): void {
  if (!draggingSiteId.value || draggingSiteId.value === siteId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropSiteId.value = siteId;
}

function onSiteDragLeave(siteId: string): void {
  if (dropSiteId.value === siteId) dropSiteId.value = null;
}

async function onSiteDrop(siteId: string): Promise<void> {
  const movingId = draggingSiteId.value;
  onSiteDragEnd();
  if (!movingId || movingId === siteId) return;
  const toIndex = store.sites.findIndex((site) => site.id === siteId);
  if (toIndex >= 0) await store.moveSite(movingId, toIndex);
}

function onSiteDragEnd(): void {
  draggingSiteId.value = null;
  dropSiteId.value = null;
}

/** Switching to the tile face ends any selection: the bar belongs to edit. */
function setMode(next: "use" | "edit"): void {
  mode.value = next;
  if (next === "use") endSelecting();
}
</script>

<template>
  <section class="page identities" :data-mode="mode">
    <!--
      A bar, not a title.

      The pane is opened from a button that already says "多账号", so a heading
      repeating it — and a subtitle repeating the count that the filter tabs
      already carry — is two lines of text to read on every visit that answer
      nothing. What the bar holds instead is the two things that are not
      repeated anywhere else: the face switch on the left, the write actions on
      the right.

      The switch is pinned left on purpose. It used to sit with the actions, so
      switching to the edit face pushed it a hundred pixels left when two buttons
      appeared beside it — a control that moves when you use it.
    -->
    <header class="pane-bar">
      <div class="mode-switch" role="group" :aria-label="$t('app.accountMode')">
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'use' }"
          :aria-pressed="mode === 'use'"
          data-mode-use
          v-tooltip="$t('app.accountModeUseHint')"
          @click="setMode('use')"
        >
          <LayoutGrid :size="13" />
        </button>
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'edit' }"
          :aria-pressed="mode === 'edit'"
          data-mode-edit
          v-tooltip="$t('app.accountModeEditHint')"
          @click="setMode('edit')"
        >
          <Pencil :size="13" />
        </button>
      </div>
      <!-- Two writes, one of them primary. Creating an account is the everyday
           act; creating a site happens once per system. They used to be two
           equal-weight buttons, which made the bar read as a menu of verbs rather
           than "this is the thing you do here". The site door is still one click
           away, as an icon with the word in its tooltip. -->
      <div v-if="mode === 'edit'" class="pane-bar-actions">
        <AppButton variant="primary" data-new-account @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </AppButton>
        <button
          type="button"
          class="bar-icon"
          :aria-label="$t('app.newSite')"
          :title="$t('app.newSite')"
          data-new-site
          @click="emit('newSite')"
        >
          <Globe :size="13" />
        </button>
      </div>
    </header>

    <div v-if="store.credentials?.warning" class="vault-banner">
      {{ store.credentials.warning }}
    </div>

    <!--
      One row of filtering. The face has three kinds of control — a status
      filter, a search field, and two switches that act on the whole list — and
      they used to occupy two rows because the group strip was a separate band
      underneath. Everything that filters now shares this row; everything that
      acts on the list sits at its right end as icon buttons, so the row's height
      is one control, not two.
    -->
    <div v-if="mode === 'edit' && store.identities.length" class="filter-bar">
      <div class="tabs" role="tablist" :aria-label="$t('app.identities')">
        <button
          type="button"
          role="tab"
          class="tab"
          :class="{ active: filter === 'all' }"
          :aria-selected="filter === 'all'"
          @click="filter = 'all'"
        >
          {{ $t("app.filterAll") }} <span class="num mono">{{ store.identities.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          :class="{ active: filter === 'running' }"
          :aria-selected="filter === 'running'"
          @click="filter = 'running'"
        >
          {{ $t("app.filterRunning") }} <span class="num mono">{{ runningCount }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          :class="{ active: filter === 'expired' }"
          :aria-selected="filter === 'expired'"
          @click="filter = 'expired'"
        >
          {{ $t("app.filterExpired") }} <span class="num mono">{{ expiredCount }}</span>
        </button>
      </div>
      <label class="search">
        <Search :size="12" />
        <input v-model="query" type="search" :placeholder="$t('app.search')" />
      </label>
      <!-- Bulk selection and the health sweep are actions over the whole list, so
           they are icons at the row's end: a text button for each pushed the
           search field down to 130px in a 720px pane. -->
      <div class="filter-actions">
        <button
          v-if="!selecting"
          type="button"
          class="bar-icon"
          :aria-label="$t('app.batchSelect')"
          :title="$t('app.batchSelectHint')"
          data-batch-select
          @click="startSelecting"
        >
          <CheckSquare :size="13" />
        </button>
        <GroupCollapseAll
          v-if="!selecting && groups.length > 1"
          :all-collapsed="allCollapsed"
          @toggle="groupCollapse.toggleAll(groupKeys)"
        />
        <button
          type="button"
          class="bar-icon"
          :class="{ on: groupsPanelOpen }"
          :aria-label="$t('app.manageSiteGroups')"
          :aria-expanded="groupsPanelOpen"
          :title="$t('app.manageSiteGroups')"
          data-manage-groups
          @click="groupsPanelOpen = !groupsPanelOpen"
        >
          <Tags :size="13" />
        </button>
        <button
          type="button"
          class="bar-icon"
          :aria-label="$t('app.sessionHealth')"
          :title="$t('app.sessionHealth')"
          data-session-health
          @click="emit('sessionHealth')"
        >
          <HeartPulse :size="13" />
        </button>
      </div>
    </div>

    <!--
      The site-group filter, on its own line and only when there are groups to
      choose between. One group is not a choice — "全部" and that group select the
      same accounts — so the line only appears from two groups up.
    -->
    <div
      v-if="mode === 'edit' && filterGroups.length > 1"
      class="group-filters"
      data-group-filters
    >
      <div class="chip-scroll">
        <button
          type="button"
          class="group-chip"
          :class="{ on: groupFilter === null }"
          @click="groupFilter = null"
        >
          {{ $t("app.filterAll") }}
        </button>
        <button
          v-for="group in filterGroups"
          :key="group.id"
          type="button"
          class="group-chip"
          :class="{ on: groupFilter === group.id }"
          :style="{ '--tag': `var(--role-${group.color})` }"
          :aria-pressed="groupFilter === group.id"
          @click="groupFilter = groupFilter === group.id ? null : group.id"
        >
          <span class="chip-dot"></span>
          {{ group.name }}
        </button>
      </div>
    </div>

    <!-- Groups are managed where they are applied. The editor is the same
         component the settings tab uses, so the two cannot diverge. -->
    <div v-if="groupsPanelOpen" class="groups-panel" data-groups-panel>
      <SiteGroupsEditor />
    </div>

    <!--
      Selection bar. It replaces the toolbar's action row rather than floating
      over the cards, so the count and the launch button stay in one place while
      the selection changes.
    -->
    <div v-if="selecting" class="select-bar">
      <button type="button" class="link" @click="toggleAll">
        {{ allSelected ? $t("app.batchClearAll") : $t("app.batchSelectAll") }}
      </button>
      <span class="sel-count mono">
        {{ $t("app.batchSelected", { count: selected.size }) }}
      </span>
      <span class="sel-note">{{ $t("app.batchLaunchNote") }}</span>
      <!-- Re-linking belongs with the other bulk actions: fixing a lost site one
           card at a time is the chore that leaves accounts unlinked. A button
           rather than a dropdown — this opens a dialog where the site is chosen
           and confirmed, so a stray click cannot move a whole batch. -->
      <AppButton :disabled="selected.size === 0" data-batch-link-site @click="openLinkSite">
        <Link2 :size="12" />
        {{ $t("app.batchLinkSite") }}
      </AppButton>
      <!-- Sharing accounts is a selection action too: pick the ones a colleague
           needs, not the whole workspace. -->
      <AppButton :disabled="selected.size === 0"
        @click="openExport">
        <Download :size="12" />
        {{ $t("app.accountsExport") }}
      </AppButton>
      <AppButton @click="endSelecting">{{ $t("app.cancel") }}</AppButton>
      <LaunchSplitButton
        variant="primary"
        :label="$t('app.batchLaunch', { count: notRunningSelected.length })"
        :disabled="!notRunningSelected.length || store.busy === 'launch'"
        data-hook="batch"
        @launch="launchSelected"
        @launch-external="launchSelectedExternal"
      />
    </div>

    <!-- Choosing the target site is a dialog, not a dropdown in the bar: the
         write moves a whole batch's home site, so it gets an explicit confirm. -->
    <Modal
      :open="linkOpen"
      :title="$t('app.batchLinkSiteTitle')"
      :description="$t('app.batchLinkSiteDesc', { count: selected.size })"
      width="440px"
      @close="linkOpen = false"
    >
      <label class="link-field">
        <span class="label">{{ $t("app.identitySite") }}</span>
        <SelectField
          v-model="linkSiteId"
          :options="siteOptions"
          :placeholder="$t('app.identitySitePick')"
          :aria-label="$t('app.identitySite')"
        />
      </label>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="linkOpen = false">{{ $t("app.cancel") }}</AppButton>
        <AppButton
          variant="primary"
          data-confirm-link-site
          :disabled="!linkSiteId || store.busy === 'identity'"
          @click="confirmLinkSite"
        >
          {{ $t("app.batchLinkSiteConfirm") }}
        </AppButton>
      </template>
    </Modal>

    <!-- Sharing a selection has one extra input — a passphrase — and that is
         enough to make it a dialog: an inline strip pushed the card grid down
         while it was open and lost the context of what was being shared. -->
    <Modal
      :open="exportOpen"
      :title="$t('app.accountsExportTitle')"
      :description="$t('app.accountsExportNote', { count: selected.size })"
      width="460px"
      @close="exportOpen = false"
    >
      <FormField :label="$t('app.accountsExportPassphrase')">
        <TextField
          v-model="exportPassphrase"
          type="password"
          autocomplete="new-password"
          :placeholder="$t('app.accountsExportPassphraseHint')"
        />
      </FormField>
      <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="exportOpen = false">{{ $t("app.cancel") }}</AppButton>
        <AppButton variant="primary" :disabled="exporting" @click="doExport">
          {{ exportPassphrase ? $t("app.accountsExportWithPassword") : $t("app.accountsExportPlain") }}
        </AppButton>
      </template>
    </Modal>

    <!--
      The tile face.
      
      One tile per account, grouped by site, and a click opens it. No pills, no
      column headers, no per-row action cluster: three pieces of information
      (name, who, whether it is running) and a target large enough to hit. This is
      the shape that stops the pane reading like a web admin console — a table is
      for reading rows field by field, which is the edit face's job.
      
      The site heading stays because a site is the only grouping an account has,
      but it carries no controls here: the count is enough, and every button that
      used to sit on it lives one switch away.
    -->
    <div v-if="mode === 'use'" class="tile-face" data-tile-face>
      <div v-if="store.identities.length" class="tile-search">
        <label class="search">
          <Search :size="12" />
          <input v-model="query" type="search" :placeholder="$t('app.search')" />
        </label>
      </div>

      <div v-for="group in groups" :key="group.siteId" class="tile-group">
        <div class="tile-head">
          <span class="tile-head-name">{{ group.name }}</span>
          <span class="tile-head-count mono">{{ group.people.length }}</span>
        </div>
        <div class="tiles">
          <button
            v-for="identity in group.people"
            :key="identity.id"
            type="button"
            class="tile"
            :class="{ running: Boolean(store.instanceFor(identity.id)) }"
            :style="{ '--role': roleVar(identity.color) }"
            :data-account-tile="identity.id"
            :title="`${identity.name} · ${identity.role}`"
            @click="launch(identity)"
          >
            <span class="tile-avatar">{{ identity.name.slice(0, 1) }}</span>
            <span class="tile-text">
              <span class="tile-name">{{ identity.name }}</span>
              <span class="tile-role">{{ identity.role }}</span>
            </span>
            <span
              class="tile-dot"
              :class="{
                live: Boolean(store.instanceFor(identity.id)),
                expired: identity.status === 'expired',
              }"
              :aria-label="statusLabel(identity)"
            ></span>
          </button>
        </div>
      </div>

      <EmptyState
        v-if="!visibleIdentities.length"
        :text="store.identities.length ? $t('app.noMatchingIdentities') : $t('app.empty')"
      >
        <template #icon><Users :size="22" /></template>
        <AppButton variant="primary" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </AppButton>
      </EmptyState>
    </div>

    <!-- The edit face: rows with every field, actions, and the write entries. -->
    <div v-else class="page-body">
      <div class="cards">
      <!-- Grouped by site; a view may span sites, so the account page no longer
           hides everything outside one global "current site". -->
      <template v-for="group in groups" :key="group.siteId">
        <!-- The whole header folds the group: the arrow alone is a 16px target,
             and this row is what the eye is on when it wants the section gone.
             The address and the add button ride in slots because they belong to
             this page, not to every grouped list. -->
        <div
          class="site-head-wrap"
          :class="{ dragging: draggingSiteId === group.siteId, drop: dropSiteId === group.siteId }"
          :data-site-row="group.siteId"
          @dragover="onSiteDragOver(group.siteId, $event)"
          @dragleave="onSiteDragLeave(group.siteId)"
          @drop.prevent="onSiteDrop(group.siteId)"
        >
        <GroupHeader
          :name="group.name"
          :count="group.people.length"
          :collapsed="groupCollapse.isCollapsed(group.siteId)"
          :data-site-head="group.siteId"
          @toggle="groupCollapse.toggle(group.siteId)"
        >
          <template #meta>
            <span v-if="group.url" class="group-url mono">{{ group.url }}</span>
            <!-- The site's own groups, so "which filing is this in" is answered
                 where the site is, not one dialog away. -->
            <span
              v-for="siteGroup in group.siteGroups"
              :key="siteGroup.id"
              class="group-badge"
              :style="{ '--tag': `var(--role-${siteGroup.color})` }"
            >
              <span class="badge-dot"></span>{{ siteGroup.name }}
            </span>
          </template>
          <template #actions>
            <template v-if="group.siteId !== '__orphan__'">
              <!-- The reorder handle. Sites are the only ordered list on this
                   page, and until now theirs had no way in from the interface. -->
              <span
                class="group-grip"
                draggable="true"
                :title="$t('app.dragReorder')"
                :aria-label="$t('app.dragReorder')"
                :data-site-grip="group.siteId"
                @dragstart.stop="onSiteDragStart(group.siteId, $event)"
                @dragend="onSiteDragEnd"
              >
                <GripVertical :size="11" />
              </span>
              <button
                type="button"
                class="group-icon"
                :title="$t('app.newIdentityHere')"
                :data-add-identity="group.siteId"
                @click.stop="emit('newIdentity', group.siteId)"
              >
                <Plus :size="11" />
              </button>
              <button
                type="button"
                class="group-icon"
                :title="$t('app.editThisSite')"
                :aria-label="$t('app.editThisSite')"
                :data-edit-site="group.siteId"
                @click.stop="emit('editSite', group.siteId)"
              >
                <Pencil :size="11" />
              </button>
            </template>
          </template>
        </GroupHeader>
        </div>
        <template v-if="!groupCollapse.isCollapsed(group.siteId)">
          <!-- One header per group: the columns are per group because a group is
               the local table. A single header above the page would sit apart
               from every group but the first. -->
          <div
            class="id-table-head"
            :class="{ picking: selecting }"
            aria-hidden="true"
          >
            <span v-if="selecting"></span>
            <span>{{ $t("app.columnAccount") }}</span>
            <span>{{ $t("app.columnRolePassword") }}</span>
            <span>{{ $t("app.status") }}</span>
            <span class="table-head-actions">{{ $t("app.columnActions") }}</span>
          </div>
          <!--
            A `div` with a button role, not a `<button>`.

            The row now carries a real launch control, and a `<button>` cannot
            contain one — the parser would close the row at the inner button's
            tag and the actions would fall outside it. The role and the key
            handlers keep everything a button gave us: a tab stop, Enter and
            Space activating the row itself, and `aria-pressed` in selection
            mode.
          -->
          <div
            v-for="(identity, index) in group.people"
            :key="identity.id"
            class="id-card"
            :class="{
              running: Boolean(store.instanceFor(identity.id)),
              picking: selecting,
              picked: selected.has(identity.id),
              last: index === group.people.length - 1,
            }"
            :style="{ '--role': roleVar(identity.color) }"
            role="button"
            tabindex="0"
            :aria-pressed="selecting ? selected.has(identity.id) : undefined"
            @click="onCardClick(identity)"
            @keydown.enter.prevent="onCardClick(identity)"
            @keydown.space.prevent="onCardClick(identity)"
          >
            <!-- Selection mode hides the per-row actions: in that mode the row is a
                 checkbox, and stop/relaunch/edit would fire from a mis-aimed click. -->
            <span v-if="selecting" class="pick-mark" :class="{ on: selected.has(identity.id) }">
              <Check v-if="selected.has(identity.id)" :size="11" />
            </span>
            <div class="card-top">
              <span class="avatar">{{ identity.name.slice(0, 1) }}</span>
              <span class="who">
                <span class="name">{{ identity.name }}</span>
                <span class="acct mono">{{ identity.username }}</span>
              </span>
            </div>

            <!--
              Two facts always, the rest counted.
              
              Every account answers "which role" and "is a password stored" —
              those are what a list of accounts is compared on, so they always
              get a chip. Everything else (a non-default browser, extra login
              fields) folds into one "+N" chip whose tooltip names them. Showing
              them inline made a four-chip row either wrap — which made its whole
              table row taller — or truncate every label into "未…" and "Micr…".
              Neither is worth a fact the user did not come to this page for.
            -->
            <div class="meta-row">
              <span class="tag tag-role" :title="identity.role">{{ identity.role }}</span>
              <span class="tag plain" :class="{ missing: !store.identityPasswordSet(identity) }">
                {{ passwordLabel(identity) }}
              </span>
              <span
                v-if="extraFacts(identity).length"
                class="tag plain more"
                :title="extraFacts(identity).join(' · ')"
                :aria-label="extraFacts(identity).join(' · ')"
              >
                +{{ extraFacts(identity).length }}
              </span>
            </div>

            <span
              class="state mono"
              :class="{
                live: Boolean(store.instanceFor(identity.id)),
                warn: identity.status === 'expired',
              }"
              :title="statusLabel(identity)"
            >
              <span class="dot"></span>{{ statusLabel(identity) }}
            </span>

            <!--
              The row's actions, in two groups.

              One row, five actions, one visual form: all of them are icon buttons
              with a tooltip. Mixed text and glyphs in the same cluster read as
              debris — three words at one weight beside a lone pencil — and a
              text action is also twice as wide as it needs to be for a verb the
              user learns once. Icons also let every row's actions end at the same
              right edge, which is what makes the column scannable.
            -->
            <div v-if="!selecting" class="card-actions">
              <span class="card-session">
                <template v-if="store.instanceFor(identity.id)">
                  <IconButton
                    :ariaLabel="$t('app.switchTo')"
                    @click.stop="launch(identity)"
                  >
                    <Play :size="12" />
                  </IconButton>
                  <IconButton
                    :ariaLabel="$t('app.stop')"
                    @click.stop="store.stopInstance(store.instanceFor(identity.id)!.id)"
                  >
                    <Square :size="11" />
                  </IconButton>
                </template>
                <!-- The plain click is the built-in surface; the arrow lists every
                     browser the app found, so the fidelity check is a decision made
                     here instead of a mode flipped in the app menu. -->
                <LaunchSplitButton
                  v-else
                  compact
                  :aria-label="$t('app.launch')"
                  :data-hook="`launch-${identity.id}`"
                  @launch="launch(identity)"
                  @launch-external="launchExternal(identity, $event)"
                />
                <IconButton
                  :ariaLabel="$t('app.relaunch')"
                  @click.stop="relogin(identity)"
                >
                  <RotateCcw :size="12" />
                </IconButton>
                <IconButton
                  :ariaLabel="$t('app.checkAuth')"
                  @click.stop="checkAuth(identity)"
                >
                  <HeartPulse :size="12" />
                </IconButton>
              </span>
              <span class="card-manage">
                <IconButton
                  :ariaLabel="$t('app.edit')"
                  :data-edit-identity="identity.id"
                  @click.stop="emit('editIdentity', identity.id)"
                >
                  <Pencil :size="12" />
                </IconButton>
              </span>
            </div>
            <div v-else class="card-pick-note mono">
              {{
                store.instanceFor(identity.id) ? $t("app.batchAlreadyRunning") : $t("app.batchWillLaunch")
              }}
            </div>
          </div>
        </template>
      </template>

      <EmptyState
        v-if="!visibleIdentities.length"
        :text="store.identities.length ? $t('app.noMatchingIdentities') : $t('app.empty')"
      >
        <template #icon><Users :size="22" /></template>
        <!-- Always the account door. A site with no accounts still needs a way
             to get its first one, and the account form starts on the site that
             was most recently used. -->
        <AppButton variant="primary" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </AppButton>
      </EmptyState>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * A floating pane is not a window.
 *
 * `.page`'s 24/28 padding is the mockup's full-page rhythm; at the pane's 720px
 * it puts the list 28px off the edge and leaves a band of nothing under the bar.
 * The pane's own edges already separate it from the page behind, so the content
 * only needs breathing room, not a margin.
 */
.page.identities {
  padding: 14px 16px 12px;
}

/*
 * The pane's one fixed row: face switch on the left, write actions on the right.
 *
 * It is a header rather than a `PageHeader` because a page header exists to say
 * the page's name, and this pane's name is already on the button that opened it.
 * Keeping it a single row also keeps the content's top edge still: the bar's
 * height does not change when the edit face's two buttons appear, so nothing
 * below it moves between faces.
 */
.pane-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 0 0 auto;
  min-height: 30px;
  padding-bottom: 12px;
}

.pane-bar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.vault-banner {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius);
  font-size: 11px;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: color-mix(in srgb, var(--accent) 78%, var(--text));
}

/*
 * One row of filtering: status tabs, the search field, then icon actions.
 *
 * `nowrap` on purpose. The row has one control of each kind plus three icons; a
 * wrap put the third icon on a line of its own, which is what made the top of the
 * pane look assembled rather than designed. The search field absorbs the slack
 * instead (`flex: 1 1 auto`), so a narrower pane shortens the field before
 * anything drops to a second line.
 */
.filter-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  flex: 0 0 auto;
  min-width: 0;
}

.filter-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

/* The filter row's icon buttons: same 26px target and same quiet colour as the
   tabs beside them, so the row reads as one band of controls. */
.bar-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.bar-icon:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

.bar-icon.on {
  background: var(--selected);
  color: var(--text);
}

.tabs {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 2px;
}

.tab {
  border-radius: var(--radius-sm);
  padding: 5px 9px;
  font-size: 11px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tab:hover {
  color: var(--text-secondary);
}

.tab.active {
  background: var(--surface-3);
  color: var(--text);
}

.num {
  font-size: 10.5px;
  color: var(--faint);
}

.tab.active .num {
  color: var(--accent-text);
}

/* The search field takes the row's slack rather than a fixed 200px: with tabs and
   three icons on the same line, a fixed width is what made the row wrap. */
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 5px 9px;
  flex: 1 1 auto;
  min-width: 96px;
  color: var(--faint);
}

.select-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: -4px 0 12px;
  padding: 8px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-elevated));
  flex: 0 0 auto;
}

.select-bar .link {
  font-size: 11.5px;
  color: var(--accent-text);
  text-decoration: underline;
}

.sel-count {
  font-size: 11px;
  color: var(--text-secondary);
}

.sel-note {
  font-size: 10.5px;
  color: var(--faint);
  flex: 1 1 auto;
  min-width: 0;
}

.select-bar .btn:last-child {
  margin-left: auto;
}

.search:focus-within {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
}

.search input {
  border: 0;
  outline: 0;
  background: transparent;
  width: 100%;
  font-size: 11px;
  color: var(--text);
}

.cards {
  /* One template for the rows and the per-group table header: a column stays a
     column across rows. The flexible tracks are `fr` rather than `auto`, so one
     long role label cannot widen the role column of only its own row. */
  /* The actions column held five controls, three of them text links, which is why
     it needed 190px. They are icon buttons now, so the column only has to fit
     five 26px targets and their gaps — the width freed up goes to the columns a
     reader actually scans. */
  --id-cols: minmax(0, 1.1fr) minmax(0, 0.8fr) 92px 168px;
  display: flex;
  flex-direction: column;
  /* Grow to the body's height so a short list still starts at the top and the
     empty state (below) has a full-height box to centre itself in. */
  flex: 1 1 auto;
  /* Rows are joined into one block, so no gap: the header is the top cap and each
     row keeps only its side and bottom rules. Groups still need air between them,
     which the group header carries. */
  gap: 0;
  min-width: 0;
  padding: 1px 2px 2px 1px;
}

/*
 * Groups are separated by air, not by a rule.
 *
 * The wrapper is what the drag handlers and the insertion line attach to, so the
 * spacing rules moved onto it. They used to name `.cards > .group-head`, which
 * stopped matching the moment a wrapper was introduced — and the symptom was
 * exactly what the rule had been added to prevent: the group's own bottom rule
 * sat a few pixels above the table's cap and the two read as one doubled line
 * glued to the content under it.
 *
 * The heading draws no rule at all now. Three gaps do the work, and their
 * difference is the hierarchy: 22px above a heading (a new site starts), 6px
 * under it (the table belongs to it), and nothing under a table's foot (the next
 * heading's own gap separates them). Without that difference a table's foot and
 * the next heading were equidistant from everything, which is what made the
 * groups read as one long list.
 */
.cards > .site-head-wrap {
  /* 28px above a heading vs 6px under it: the ratio is what says "a new site
     starts here" instead of "the table continues with a label". At 22 the two
     gaps were close enough that a table's foot and the next heading read as one
     run. */
  margin-top: 28px;
}

.cards > .site-head-wrap:first-child {
  margin-top: 0;
}

.cards > .site-head-wrap :deep(.group-head) {
  border-bottom: 0;
  padding-bottom: 6px;
}

.id-table-head {
  display: grid;
  grid-template-columns: var(--id-cols);
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.id-table-head.picking {
  grid-template-columns: 16px var(--id-cols);
}

.table-head-actions {
  justify-self: end;
}

.group-url {
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.group-icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  border: 1px solid var(--line-soft);
  color: var(--faint);
}

.group-icon:hover {
  color: var(--text);
  border-color: var(--line);
}

/* A site's memberships, drawn as small filled pills so several can sit on one
   line beside the address without reading as buttons. */
.group-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: var(--fs-2xs);
  color: color-mix(in srgb, var(--tag) 78%, var(--text));
  background: color-mix(in srgb, var(--tag) 10%, transparent);
  white-space: nowrap;
}

.badge-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--tag);
}

/* ------------------------------------------------------------------ */
/* The use face                                                        */
/* ------------------------------------------------------------------ */

/*
 * A tile is a launch target, not a row of data.
 *
 * The page is a floating pane, never a full window, so "how much fits" is decided
 * by about 700px of width: three tiles per row, each about 30px shorter than the
 * table row it replaces, and no column rules. What the tile drops (password mode,
 * browser, extra fields) is exactly what the edit face is for.
 */
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.mode {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.mode:hover {
  color: var(--text-secondary);
}

.mode.on {
  background: var(--surface-3);
  color: var(--text);
}

.tile-face {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-bottom: 4px;
}

.tile-search .search {
  margin-left: 0;
  width: 100%;
  flex: 0 0 auto;
}

.tile-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tile-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--faint);
}

.tile-head-count {
  font-size: 10px;
  color: var(--muted);
}

.tiles {
  display: grid;
  /* A consistent column width across groups, rather than stretching two tiles to
     fill a row that could hold three. `auto-fill` keeps the empty track, so a
     site with two accounts puts them at the same size as a site with five —
     stretching is what makes a two-account group look like a different widget
     from a five-account one. */
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.tile {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}

.tile:hover {
  border-color: color-mix(in srgb, var(--role) 55%, var(--line));
  background: var(--bg-elevated);
}

.tile-avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--role) 18%, transparent);
  color: color-mix(in srgb, var(--role) 78%, var(--text));
  font-size: 12px;
}

.tile-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.tile-name {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-role {
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--line);
}

.tile-dot.live {
  background: var(--green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 18%, transparent);
}

.tile-dot.expired {
  background: var(--red);
}

/* ------------------------------------------------------------------ */
/* Site reordering (edit face)                                         */
/* ------------------------------------------------------------------ */

.site-head-wrap.dragging {
  opacity: 0.5;
}

/* Insertion line: the heading below the pointer receives the dragged site. */
.site-head-wrap.drop {
  box-shadow: inset 0 2px 0 var(--accent);
}

.group-grip {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 18px;
  flex: 0 0 16px;
  color: var(--faint);
  cursor: grab;
}

.group-grip:active {
  cursor: grabbing;
}

/* One fixed line of chips that scrolls sideways. Wrapping made the bar grow with
   every group, pushing the sections out of view once a workspace had a dozen of
   them. */
.group-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  /* Tight under the filter row — the two are one block of controls — and the
     first group heading's own 22px is what separates them from the list. */
  margin: 0 0 6px;
  flex: 0 0 auto;
}

.chip-scroll {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  overflow-y: hidden;
  min-width: 0;
  flex: 1 1 auto;
  padding: 1px 0 2px;
  scrollbar-width: thin;
}

.group-chip {
  --tag: var(--accent);
  background: transparent;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
}

.group-chip.on {
  border-color: color-mix(in srgb, var(--tag) 52%, var(--line));
  background: color-mix(in srgb, var(--tag) 10%, transparent);
  color: color-mix(in srgb, var(--tag) 78%, var(--text));
}

.chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tag);
  opacity: 0.75;
}

.id-card {
  --role: var(--role-slate);
  position: relative;
  text-align: left;
  /* A `div` with a button role: the native button's own chrome has to be
     neutralised by hand now that a real launch control lives inside it. */
  cursor: pointer;
  font: inherit;
  color: inherit;
  /* Same reasoning as the sites row: the page and the row share a surface, so
     the edge has to be the stronger hairline or the row disappears into the
     background in the light theme. */
  display: grid;
  grid-template-columns: var(--id-cols);
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 46px;
  padding: 7px 10px 7px 12px;
  border: 1px solid var(--line);
  /* Joined rows: the header is the cap, the last row is the foot, and every row
     between keeps only its side and bottom rules. */
  border-top: 0;
  border-radius: 0;
  /* One flat surface. A border and the identity's own left rule are enough to
     separate a row from the page. */
  background: var(--surface);
  overflow: hidden;
  transition: border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out);
}

/* The table's foot: the last row of a group's block. Every row is a sibling of
   the group's header (the `template v-for` adds no wrapper), so "last in this
   group" is not something `nth-*` can express across groups — the class says it. */
.id-card.last {
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.id-card.picking {
  grid-template-columns: 16px var(--id-cols);
  cursor: pointer;
}

.view-table .id-card {
  border-radius: 0;
  border-top: 0;
}

.id-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: var(--role);
  opacity: 0.9;
}

/* No lift on hover: a row that rises under the cursor makes a list feel like a
   stack of loose tiles. The border taking the identity colour is the response. */
.id-card:hover {
  border-color: color-mix(in srgb, var(--role) 34%, var(--line));
}

.id-card.running {
  border-color: color-mix(in srgb, var(--role) 46%, var(--line));
  background: var(--surface-2);
}

.id-card.picked {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}

/* A checkbox in the leading cell, sized like the rows' own tags so it reads as
   part of the row rather than an overlay widget. */
.pick-mark {
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  display: grid;
  place-items: center;
  color: var(--action-foreground);
}

.pick-mark.on {
  border-color: transparent;
  background: var(--action);
}

.card-pick-note {
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatar {
  /* 32px from the mockup, not 24. At 24 the initial was smaller than the card's
     own name text and the card read as a list row; the mockup's card is built
     around a square avatar as the anchor, with the name and address beside it. */
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--role) 15%, var(--surface));
  color: color-mix(in srgb, var(--role) 82%, var(--text));
  font-size: var(--fs-base);
  font-weight: 500;
}

/* Name over account, not beside it. The account cell in a row is narrow enough
   that side-by-side name and address would each truncate to a few characters;
   stacked, both usually fit and the row height still has room for the avatar. */
.who {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.name {
  font-size: var(--fs-base);
  font-weight: 500;
  letter-spacing: 0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acct {
  font-size: var(--fs-2xs);
  line-height: 1.35;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
  flex: 0 0 auto;
}

.state .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--role) 45%, var(--faint));
}

.state.live {
  color: var(--green);
}

.state.live .dot {
  background: var(--green);
  box-shadow: 0 0 7px color-mix(in srgb, var(--green) 70%, transparent);
}

.state.warn {
  color: var(--accent-text);
}

.state.warn .dot {
  background: var(--accent);
}

/*
 * Facts stay on ONE line, and the row stays the same height whatever an account
 * carries.
 *
 * The row used to wrap. That looked harmless while every seed account had the
 * same three chips, but a real workspace has accounts with a long role label, a
 * custom engine and several extra fields — those rows grew a second chip line,
 * the whole table row stretched to match, and every neighbouring row got a band
 * of empty space under its actions. One aligned line of chips is what makes a
 * list of accounts comparable at a glance, which is the only reason this page
 * exists.
 *
 * So the row holds exactly what always fits: the role (given its natural width,
 * it is the fact people scan for) and the password state. Anything else becomes
 * a "+N" chip (see `extraFacts`).
 */
.meta-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: nowrap;
  overflow: hidden;
  min-height: 18px;
}

.tag {
  font-size: 10px;
  letter-spacing: 0.03em;
  border: 1px solid color-mix(in srgb, var(--role) 30%, var(--line));
  border-radius: 3px;
  padding: 2px 5px;
  color: color-mix(in srgb, var(--role) 72%, var(--text-secondary));
  background: color-mix(in srgb, var(--role) 7%, transparent);
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The role must not be cut: "数据管理员 · 读写" truncated to "数据管理…" is the
   same as no label at all. But letting it take 62% left the password chip with
   whatever was left, which is how every row in a narrow pane read
   "member 未设…". It may push, not dominate: the cap is half the column, and the
   password chip shares the rest. */
.meta-row > .tag-role {
  flex: 0 1 auto;
  max-width: 50%;
}

.meta-row > .tag.plain {
  flex: 0 1 auto;
  min-width: 0;
}

/* The counter never shrinks: a half-drawn "+" is worse than a missing chip. */
.meta-row > .tag.more {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.tag.plain {
  color: var(--faint);
  border-color: var(--line-soft);
  background: transparent;
}

/* "No password" is the one fact on this line that needs attention, so it is the
   one that gets a colour. Everything else is neutral by design. */
.tag.plain.missing {
  color: color-mix(in srgb, var(--accent) 82%, var(--text));
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line-soft));
}

/*
 * Always visible, in the last column of the row.
 *
 * Folding this cell until hover was a mistake: the row changed height whenever
 * the pointer crossed it, so the list reflowed as the mouse moved. A stable row
 * is worth more than the ~18px it saves.
 *
 * The cell does not wrap, for the same reason the facts cell does not: one
 * account with an extra action ("stop" instead of "switch") must not make its
 * row one line taller than the rest. Session actions sit left, management
 * actions are pinned to the right edge as icon buttons.
 */
.card-actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: flex-end;
  /* The wider space is between the two groups, not between neighbours inside
     one: session actions are things you do to a running page, the pencil edits
     the account. A uniform gap made the cluster read as five equal verbs. */
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--muted);
}

.card-session {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* Not `flex: 1 1 auto`. That let the session group absorb every spare pixel of
     the actions column, so its actions sat at the left edge of a wide gap while
     the edit icon sat alone at the right edge — the row read as "three links …
     a distant pencil". The column is right-aligned; this group should only be as
     wide as what it holds. */
  flex: 0 0 auto;
  overflow: hidden;
}

.card-manage {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

/* Dialog footer layout. Scoped styles do not reach Modal's own slots, so the
   spacer has to be defined here rather than reused from another component. */
.spacer {
  flex: 1;
}

.link-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-field .label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

/* The export dialog's two bits of furniture. Its body is one labelled field, so
   it borrows the link dialog's caption treatment rather than a second style. */
.field .label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

/* The frame comes from the shared `.empty` rule; only the placement is this
   page's own. The response is normally a grid, but the shared `.empty` centres
   itself with `margin: auto`, which does nothing inside a grid whose rows are
   content-height — so when the grid holds nothing but the placeholder, it
   becomes a one-item flex column and the shared centring works as written.
   The width override stays: the shared cap is a measure for prose, and without
   it the box shrank to a 264px column and the button label wrapped. */
.cards:has(> .empty) {
  display: flex;
  flex-direction: column;
}

.empty {
  justify-self: center;
}

@media (max-width: 820px) {
  .cards {
    --id-cols: minmax(0, 1.1fr) minmax(0, 0.8fr) 78px minmax(150px, 1.4fr);
  }
}

@media (max-width: 900px) {
  .identities {
    padding: 14px;
  }

  .search {
    width: 150px;
  }
}
</style>
