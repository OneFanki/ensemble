<script setup lang="ts">
import type { Identity, RoleColor } from "@shared/types";
import { Check, CheckSquare, Download, HeartPulse, LayoutGrid, Link2, Play, Plus, Search, Square } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useGroupCollapse } from "../composables/useGroupCollapse";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import GroupChevron from "./GroupChevron.vue";
import GroupCollapseAll from "./GroupCollapseAll.vue";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";

const emit = defineEmits<{
  newIdentity: [siteId?: string];
  editIdentity: [id: string];
  sessionHealth: [];
  /** Opens the view form with these accounts already chosen. */
  createView: [identityIds: string[]];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();
const filter = ref<"all" | "running" | "expired">("all");
const query = ref("");
/**
 * Selection mode. The cards are buttons that launch (or open) on click, so
 * launching a handful one by one means every new browser window covers the next
 * card. In this mode a click toggles a checkbox instead, and one action launches
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
  if (store.settings.launchTarget === "embedded") {
    // A batch is the one launch that is about a layout, so it gets its own
    // container instead of scattering pages into the tab strip.
    await embedded.openIdentitiesInNewView(ids);
  } else {
    await store.launchIdentities(ids);
  }
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
function createViewFromSelection() {
  const ids = [...selected.value];
  if (ids.length === 0) return;
  emit("createView", ids);
  endSelecting();
}

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

/** Tag filter; `null` means every account. */
const tagFilter = ref<string | null>(null);

const visibleIdentities = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.identities.filter((identity) => {
    const running = Boolean(store.instanceFor(identity.id));
    if (filter.value === "running" && !running) return false;
    if (filter.value === "expired" && identity.status !== "expired") return false;
    if (tagFilter.value && !store.tagsForIdentity(identity).includes(tagFilter.value)) return false;
    if (!term) return true;
    return (
      identity.name.toLowerCase().includes(term) ||
      identity.username.toLowerCase().includes(term) ||
      identity.role.toLowerCase().includes(term)
    );
  });
});

/**
 * Accounts grouped by site.
 *
 * This replaced a title-bar site switcher: one global "current site" scoped
 * every page at once, which the embedded browser never honoured. Grouping keeps
 * the same information visible without hiding anything.
 */
const groups = computed(() => {
  const result: Array<{ siteId: string; name: string; url: string; people: Identity[] }> = [];
  for (const site of store.sites) {
    const people = visibleIdentities.value.filter((identity) => identity.siteId === site.id);
    if (people.length === 0) continue;
    result.push({ siteId: site.id, name: site.name, url: site.baseUrl, people });
  }
  const orphans = visibleIdentities.value.filter(
    (identity) => !store.sites.some((site) => site.id === identity.siteId),
  );
  if (orphans.length > 0) {
    result.push({
      siteId: "__orphan__",
      name: t("app.identityOrphanSite"),
      url: "",
      people: orphans,
    });
  }
  return result;
});

const groupKeys = computed(() => groups.value.map((group) => group.siteId));
const allCollapsed = computed(() => groupCollapse.allCollapsed(groupKeys.value));

/** Tags that actually appear on some account, so the filter never lists dead ends. */
const filterTags = computed(() => {
  const used = new Set<string>();
  for (const identity of store.identities) {
    for (const tagId of store.tagsForIdentity(identity)) used.add(tagId);
  }
  return (store.snapshot?.tags ?? []).filter((tag) => used.has(tag.id));
});

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
 * Launch through whichever surface the title bar selected.
 *
 * The page must not offer a second "built-in browser" action beside launch: that
 * made one decision look like two unrelated features, and the choice belongs in
 * one place for every page.
 *
 * Built-in means "a new tab in the default tab strip", always — even when a view
 * is on stage or the account is already running somewhere. Clicking a card is a
 * request for that page, not an instruction to rearrange the stage; moving into
 * a view is the drag gesture or the view's own "add tab".
 */
async function launchHere(identity: Identity): Promise<void> {
  if (store.settings.launchTarget === "external") {
    // External windows exist once per identity, so re-launching means raising
    // the running one; there is no tab strip to add a second page to.
    const instance = store.instanceFor(identity.id);
    if (instance) {
      await store.focusInstance(instance.id);
      return;
    }
    await store.launchIdentity(identity.id);
    return;
  }
  await embedded.openIdentity(identity.id);
}

async function relogin(identity: Identity) {
  const instance = store.instanceFor(identity.id);
  if (instance) {
    await store.fillLogin(identity.id);
    return;
  }
  if (store.settings.launchTarget === "embedded") {
    // The embedded surface has no login page to submit; opening the identity's
    // start page and filling it is the equivalent action.
    await embedded.openIdentity(identity.id);
    return;
  }
  const site = store.sites.find((item) => item.id === identity.siteId);
  const launched = await store.launchIdentity(identity.id, site?.loginPath);
  // A launch already fills on its own when the setting is on; filling again here
  // would type the same credentials twice and submit the form twice.
  if (launched && !store.settings.autoFillOnLaunch) await store.fillLogin(identity.id);
}

async function checkAuth(identity: Identity) {
  await store.checkAuth(identity.id);
}

function passwordLabel(identity: Identity): string {
  if (identity.passwordMode === "reference") return t("app.passwordReferenced");
  if (!store.identityPasswordSet(identity)) return t("app.passwordNotSet");
  return identity.passwordMode === "custom" ? t("app.passwordCustom") : t("app.passwordInherit");
}
</script>

<template>
  <section class="identities">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.identities") }}</h1>
        <p class="mono">
          {{ $t("app.identityCount", { count: store.identities.length }) }}
          <template v-if="runningCount"> · {{ $t("app.statusRunning") }} {{ runningCount }}</template>
        </p>
      </div>
      <div class="head-actions">
        <AppButton variant="primary" data-tour="new-identity" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </AppButton>
      </div>
    </header>

    <div v-if="store.credentials?.warning" class="vault-banner">
      {{ store.credentials.warning }}
    </div>

    <div class="toolbar">
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
      <AppButton v-if="!selecting"
        data-batch-select
        :title="$t('app.batchSelectHint')"
        @click="startSelecting">
        <CheckSquare :size="12" />
        {{ $t("app.batchSelect") }}
      </AppButton>
      <GroupCollapseAll
        v-if="!selecting && groups.length > 1"
        :all-collapsed="allCollapsed"
        @toggle="groupCollapse.toggleAll(groupKeys)"
      />
      <AppButton class="health" @click="emit('sessionHealth')">
        <HeartPulse :size="13" />
        {{ $t("app.sessionHealth") }}
      </AppButton>
    </div>

    <!--
      Tag filters get their own strip, one line high, scrolled sideways.
      A wrapping list was fine with three tags and pushed the cards off screen
      with fifteen; a fixed-height strip keeps the page layout stable no matter
      how many tags exist.
    -->
    <div v-if="filterTags.length" class="tag-filters">
      <span class="filters-label">{{ $t("app.tags") }}</span>
      <div class="chip-scroll">
        <button
          type="button"
          class="tag-chip"
          :class="{ on: tagFilter === null }"
          @click="tagFilter = null"
        >
          {{ $t("app.filterAll") }}
        </button>
        <button
          v-for="tag in filterTags"
          :key="tag.id"
          type="button"
          class="tag-chip"
          :class="{ on: tagFilter === tag.id }"
          :style="{ '--tag': `var(--role-${tag.color})` }"
          :aria-pressed="tagFilter === tag.id"
          @click="tagFilter = tagFilter === tag.id ? null : tag.id"
        >
          <span class="chip-dot"></span>
          {{ tag.name }}
        </button>
      </div>
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
      <!-- Saving the selection as a view is the durable version of the batch
           launch: same picking gesture, but the group gets a name, a layout and
           a row on the views page instead of a scratch container. -->
      <AppButton :disabled="selected.size === 0" data-batch-create-view @click="createViewFromSelection">
        <LayoutGrid :size="12" />
        {{ $t("app.batchCreateView") }}
      </AppButton>
      <!-- Sharing accounts is a selection action too: pick the ones a colleague
           needs, not the whole workspace. -->
      <AppButton :disabled="selected.size === 0"
        @click="openExport">
        <Download :size="12" />
        {{ $t("app.accountsExport") }}
      </AppButton>
      <AppButton @click="endSelecting">{{ $t("app.cancel") }}</AppButton>
      <AppButton variant="primary" :disabled="!notRunningSelected.length || store.busy === 'launch'"
        @click="launchSelected">
        <Play :size="12" />
        {{ $t("app.batchLaunch", { count: notRunningSelected.length }) }}
      </AppButton>
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

    <div v-if="exportOpen" class="export-bar">
      <div class="export-copy">
        <p class="export-title">{{ $t("app.accountsExportTitle") }}</p>
        <p class="export-note">{{ $t("app.accountsExportNote", { count: selected.size }) }}</p>
      </div>
      <label class="export-pass">
        <span>{{ $t("app.accountsExportPassphrase") }}</span>
        <input
          v-model="exportPassphrase"
          type="password"
          autocomplete="new-password"
          :placeholder="$t('app.accountsExportPassphraseHint')"
        />
      </label>
      <p v-if="exportError" class="error">{{ exportError }}</p>
      <div class="export-actions">
        <AppButton @click="exportOpen = false">
          {{ $t("app.cancel") }}
        </AppButton>
        <AppButton variant="primary" :disabled="exporting" @click="doExport">
          {{ exportPassphrase ? $t("app.accountsExportWithPassword") : $t("app.accountsExportPlain") }}
        </AppButton>
      </div>
    </div>

    <div class="cards">
      <!-- Grouped by site; a view may span sites, so the account page no longer
           hides everything outside one global "current site". -->
      <template v-for="group in groups" :key="group.siteId">
        <!-- The whole header folds the group: the arrow alone is a 16px target,
             and this row is what the eye is on when it wants the section gone. -->
        <div
          class="group-head"
          :class="{ collapsed: groupCollapse.isCollapsed(group.siteId) }"
          role="button"
          tabindex="0"
          :aria-expanded="!groupCollapse.isCollapsed(group.siteId)"
          @click="groupCollapse.toggle(group.siteId)"
          @keydown.enter.prevent="groupCollapse.toggle(group.siteId)"
        >
          <GroupChevron
            :collapsed="groupCollapse.isCollapsed(group.siteId)"
            :name="group.name"
            @toggle="groupCollapse.toggle(group.siteId)"
          />
          <span class="group-name">{{ group.name }}</span>
          <span v-if="group.url" class="group-url mono">{{ group.url }}</span>
          <span class="group-count mono">{{ group.people.length }}</span>
          <button
            v-if="group.siteId !== '__orphan__'"
            type="button"
            class="group-add"
            :title="$t('app.newIdentityHere')"
            @click.stop="emit('newIdentity', group.siteId)"
          >
            <Plus :size="11" />
          </button>
        </div>
        <template v-if="!groupCollapse.isCollapsed(group.siteId)">
          <button
            v-for="identity in group.people"
            :key="identity.id"
            type="button"
            class="id-card"
            :class="{
              running: Boolean(store.instanceFor(identity.id)),
              picking: selecting,
              picked: selected.has(identity.id),
            }"
            :style="{ '--role': roleVar(identity.color) }"
            :aria-pressed="selecting ? selected.has(identity.id) : undefined"
            @click="
              selecting
                ? toggleSelected(identity.id)
                : store.instanceFor(identity.id)
                  ? launch(identity)
                  : emit('editIdentity', identity.id)
            "
          >
            <!-- Selection mode hides the per-card actions: in that mode the card is a
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
            </div>

            <!--
              One line, three facts, all of them things a user actually asks
              about a card: which role it is, whether a password is stored, and
              (only when it differs from the default) which browser it opens in.
              The old layout spent three rows on a password-dots decoration and a
              role/engine chip pair, with the same information to say.
            -->
            <div class="meta-row">
              <span class="tag">{{ identity.role }}</span>
              <span class="tag plain" :class="{ missing: !store.identityPasswordSet(identity) }">
                {{ passwordLabel(identity) }}
              </span>
              <span v-if="identity.engineId" class="tag plain">
                {{ store.engineFor(identity)?.brand ?? "—" }}
              </span>
              <span v-if="identity.extraFields?.length" class="tag plain">
                {{ $t("app.identityFieldCount", { count: identity.extraFields.length }) }}
              </span>
            </div>

            <div v-if="!selecting" class="card-actions">
              <template v-if="store.instanceFor(identity.id)">
                <span class="launch" @click.stop="launch(identity)">
                  <Play :size="10" />
                  {{ $t("app.switchTo") }}
                </span>
                <span @click.stop="store.stopInstance(store.instanceFor(identity.id)!.id)">
                  <Square :size="9" />
                  {{ $t("app.stop") }}
                </span>
              </template>
              <span v-else class="launch" @click.stop="launch(identity)">
                <Play :size="10" />
                {{ $t("app.launch") }}
              </span>
              <span @click.stop="relogin(identity)">{{ $t("app.relaunch") }}</span>
              <span @click.stop="checkAuth(identity)">{{ $t("app.checkAuth") }}</span>
              <span class="edit" @click.stop="emit('editIdentity', identity.id)">{{ $t("app.edit") }}</span>
            </div>
            <div v-else class="card-pick-note mono">
              {{
                store.instanceFor(identity.id) ? $t("app.batchAlreadyRunning") : $t("app.batchWillLaunch")
              }}
            </div>
          </button>
        </template>
      </template>

      <div v-if="!visibleIdentities.length" class="empty">
        <p>{{ store.identities.length ? $t("app.noMatchingIdentities") : $t("app.empty") }}</p>
        <AppButton variant="primary" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </AppButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.identities {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 12px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex: 0 0 auto;
}

.head-copy {
  min-width: 0;
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
}

.head-copy p {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
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

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 16px 0 12px;
  flex: 0 0 auto;
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
  color: var(--accent);
}

.search {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 6px 9px;
  width: 200px;
  min-width: 130px;
  flex: 0 1 200px;
  color: var(--faint);
}

/* Kept out of the header: three action buttons crowded the title at the minimum
   window width, and the expired filter next to it is the same mental context. */
.health {
  flex: 0 0 auto;
  padding: 6px 10px;
  font-size: 11.5px;
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
  color: var(--accent);
  text-decoration: underline;
}

/*
 * Export panel. Sits under the selection bar and pushes the cards down only
 * while it is open — this is a deliberate step, not a prompt that appears on its
 * own, so it may take space.
 */
.export-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin: -4px 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  flex: 0 0 auto;
}

.export-copy {
  flex: 1 1 240px;
  min-width: 0;
}

.export-title {
  margin: 0;
  font-size: 12px;
  color: var(--text);
}

.export-note {
  margin: 3px 0 0;
  font-size: 10.5px;
  color: var(--faint);
  line-height: 1.5;
}

.export-pass {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10.5px;
  color: var(--faint);
}

.export-pass input {
  width: 190px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 11.5px;
  outline: 0;
}

.export-pass input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.export-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
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
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  /* Column count follows the window: the whole point of this page is comparing
     many accounts at once, so a fixed two columns wasted half the width on a
     desktop screen. 264px is the narrowest a card reads at without truncating
     the name and the status into each other. */
  grid-template-columns: repeat(auto-fill, minmax(264px, 1fr));
  /* An explicit row floor: as an auto-sized grid item inside a scrolling flex
     column, rows were compressed to the container's leftover height, and the
     card's own `overflow: hidden` then clipped its action row. Rows must size to
     their content — the grid scrolls, it does not shrink its cells. */
  grid-auto-rows: min-content;
  gap: 7px;
  align-content: start;
  padding: 1px 2px 2px 1px;
}

/* Site group headers span the grid; they are the replacement for the old
   title-bar site switcher, so they carry the address and the count. */
.group-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 2px 2px;
  border-bottom: 1px solid var(--line-soft);
  cursor: pointer;
}

.group-head:first-child {
  padding-top: 0;
}

.group-head:hover .group-name {
  color: var(--text);
}

/* Folded: the name and count stay, the cards go. A dashed rule is the quiet
   version of "this section is closed" — a solid rule with nothing under it reads
   as a rendering bug. */
.group-head.collapsed {
  border-bottom-style: dashed;
  padding-bottom: 6px;
}

.group-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.group-url {
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.group-count {
  font-size: 10.5px;
  color: var(--faint);
}

.group-add {
  margin-left: auto;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  border: 1px solid var(--line-soft);
  color: var(--faint);
}

.group-add:hover {
  color: var(--text);
  border-color: var(--line);
}

/* One fixed line of chips that scrolls sideways. Wrapping made the toolbar grow
   with every tag, pushing the cards out of view once a workspace had a dozen. */
.tag-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: -6px 0 12px;
  flex: 0 0 auto;
}

.filters-label {
  flex: 0 0 auto;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--faint);
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

.tag-chip {
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

.tag-chip.on {
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
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, var(--surface), var(--bg-elevated));
  /* Dense on purpose: the page's job is comparing many accounts at once, and a
     card that spends three rows on a password-dots decoration costs a visible
     slice of screen per account. One identity line plus one fact line is the
     whole card; the action row appears on hover so it costs no height. */
  padding: 8px 10px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: hidden;
  min-width: 0;
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease;
}

.id-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: var(--role);
  opacity: 0.9;
}

.id-card:hover {
  border-color: color-mix(in srgb, var(--role) 34%, var(--line));
  transform: translateY(-1px);
}

.id-card.running {
  border-color: color-mix(in srgb, var(--role) 46%, var(--line));
  background: linear-gradient(180deg, var(--surface-2), var(--surface));
}

.id-card.picking {
  cursor: pointer;
}

.id-card.picked {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}

/* A checkbox in the corner, sized like the cards' own tags so it reads as part
   of the card rather than an overlay widget. */
.pick-mark {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  display: grid;
  place-items: center;
  color: var(--accent-foreground);
}

.pick-mark.on {
  border-color: var(--accent);
  background: var(--accent);
}

/* The status text sits in the same corner, so it yields while selecting. */
.id-card.picking .state {
  opacity: 0;
}

.card-pick-note {
  font-size: 10.5px;
  color: var(--faint);
  border-top: 1px solid var(--line-soft);
  padding-top: 5px;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatar {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--role) 15%, var(--surface));
  color: color-mix(in srgb, var(--role) 82%, var(--text));
  font-size: 11px;
  font-weight: 500;
}

.who {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.name {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
}

.acct {
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
}

.state {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  color: var(--accent);
}

.state.warn .dot {
  background: var(--accent);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  min-height: 0;
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
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
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
 * Always visible, three rows in total: identity, facts, actions.
 *
 * Folding this row until hover was a mistake: the card changed height whenever
 * the pointer crossed it, so a grid of cards reflowed as the mouse moved. A
 * stable card is worth more than the ~18px it saves, and three rows is the size
 * the page was designed around anyway.
 */
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 11px;
  font-size: 11px;
  color: var(--muted);
}

.card-actions > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.card-actions > span:hover {
  color: var(--text);
}

.launch {
  color: color-mix(in srgb, var(--role) 76%, var(--text));
}

.edit {
  margin-left: auto;
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

.empty {
  grid-column: 1 / -1;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  padding: 32px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.empty p {
  margin: 0;
}

@media (max-width: 820px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 900px) {
  .identities {
    padding: 14px;
  }

  .head {
    flex-wrap: wrap;
  }

  .search {
    width: 150px;
  }
}
</style>
