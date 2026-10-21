<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Check,
  CheckSquare,
  Globe,
  HeartPulse,
  Play,
  Plus,
  Search,
  Square,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import type { Identity, RoleColor } from "@shared/types";

const emit = defineEmits<{
  newIdentity: [];
  editIdentity: [id: string];
  sessionHealth: [];
}>();

const store = useWorkspaceStore();
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

const allSelected = computed(
  () =>
    visibleIdentities.value.length > 0 &&
    visibleIdentities.value.every((identity) => selected.value.has(identity.id)),
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
    : new Set(visibleIdentities.value.map((identity) => identity.id));
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
  await store.launchIdentities(ids);
  endSelecting();
}

const roleVar = (color: RoleColor) => `var(--role-${color})`;

const visibleIdentities = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.environmentIdentities.filter((identity) => {
    const running = Boolean(store.instanceFor(identity.id));
    if (filter.value === "running" && !running) return false;
    if (filter.value === "expired" && identity.status !== "expired") return false;
    if (!term) return true;
    return (
      identity.name.toLowerCase().includes(term) ||
      identity.username.toLowerCase().includes(term) ||
      identity.role.toLowerCase().includes(term)
    );
  });
});

const runningCount = computed(
  () => store.environmentIdentities.filter((i) => store.instanceFor(i.id)).length,
);
const expiredCount = computed(
  () => store.environmentIdentities.filter((i) => i.status === "expired").length,
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
  const instance = store.instanceFor(identity.id);
  if (instance) {
    // Clicking a running identity raises its window; stopping is its own button.
    await store.focusInstance(instance.id);
    return;
  }
  await store.launchIdentity(identity.id);
}

async function relogin(identity: Identity) {
  const instance = store.instanceFor(identity.id);
  if (instance) {
    await store.fillLogin(identity.id);
    return;
  }
  const launched = await store.launchIdentity(identity.id, store.activeEnvironment?.loginPath);
  // A launch already fills on its own when the setting is on; filling again here
  // would type the same credentials twice and submit the form twice.
  if (launched && !store.settings.autoFillOnLaunch) await store.fillLogin(identity.id);
}

async function checkAuth(identity: Identity) {
  await store.checkAuth(identity.id);
}

function passwordLabel(identity: Identity): string {
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
          {{ store.activeEnvironment?.baseUrl ?? "—" }} ·
          {{ $t("app.identityCount", { count: store.environmentIdentities.length }) }}
          <template v-if="runningCount"> · {{ $t("app.statusRunning") }} {{ runningCount }}</template>
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="store.launchScopedCleanSession()">
          <Globe :size="13" />
          {{ $t("app.cleanSession") }}
        </button>
        <button class="btn primary" type="button" data-tour="new-identity" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </button>
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
          {{ $t("app.filterAll") }} <span class="num mono">{{ store.environmentIdentities.length }}</span>
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
      <button
        v-if="!selecting"
        class="btn"
        type="button"
        :title="$t('app.batchSelectHint')"
        @click="startSelecting"
      >
        <CheckSquare :size="12" />
        {{ $t("app.batchSelect") }}
      </button>
      <button class="btn health" type="button" @click="emit('sessionHealth')">
        <HeartPulse :size="13" />
        {{ $t("app.sessionHealth") }}
      </button>
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
      <button type="button" class="btn" @click="endSelecting">{{ $t("app.cancel") }}</button>
      <button
        type="button"
        class="btn primary"
        :disabled="!notRunningSelected.length || store.busy === 'launch'"
        @click="launchSelected"
      >
        <Play :size="12" />
        {{ $t("app.batchLaunch", { count: notRunningSelected.length }) }}
      </button>
    </div>

    <div class="cards">
      <button
        v-for="identity in visibleIdentities"
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
          >
            <span class="dot"></span>{{ statusLabel(identity) }}
          </span>
        </div>

        <div class="meta-row">
          <span class="tag">{{ identity.role }}</span>
          <span class="tag plain">{{ store.engineFor(identity)?.brand ?? "—" }}</span>
        </div>

        <div class="pw-row">
          <span class="dots mono">{{ store.identityPasswordSet(identity) ? "••••••••" : "— — — —" }}</span>
          <span class="inherit mono">{{ passwordLabel(identity) }}</span>
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

      <div v-if="!visibleIdentities.length" class="empty">
        <p>{{ store.environmentIdentities.length ? $t("app.noMatchingIdentities") : $t("app.empty") }}</p>
        <button class="btn primary" type="button" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </button>
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

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 11px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease;
}

.btn:hover {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.primary:hover {
  filter: brightness(1.06);
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  align-content: start;
  padding: 1px 2px 2px 1px;
}

.id-card {
  --role: var(--role-slate);
  position: relative;
  text-align: left;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, var(--surface), var(--bg-elevated));
  padding: 11px 11px 9px 13px;
  display: flex;
  flex-direction: column;
  gap: 9px;
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
  padding-top: 8px;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.avatar {
  width: 29px;
  height: 29px;
  flex: 0 0 29px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--role) 15%, var(--surface));
  color: color-mix(in srgb, var(--role) 82%, var(--text));
  font-size: 11.5px;
  font-weight: 500;
}

.who {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.name {
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acct {
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
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
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border: 1px solid color-mix(in srgb, var(--role) 30%, var(--line));
  border-radius: 3px;
  padding: 3px 5px;
  color: color-mix(in srgb, var(--role) 72%, var(--text-secondary));
  background: color-mix(in srgb, var(--role) 7%, transparent);
}

.tag.plain {
  color: var(--faint);
  border-color: var(--line-soft);
  background: transparent;
}

.pw-row {
  display: flex;
  align-items: center;
  gap: 7px;
  border-top: 1px solid var(--line-soft);
  padding-top: 8px;
}

.dots {
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--muted);
}

.inherit {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11.5px;
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

@media (max-width: 1180px) {
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
