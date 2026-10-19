<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Globe,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import { isProductionName } from "@shared/environments";
import type { Identity, RoleColor } from "@shared/types";

const emit = defineEmits<{
  newIdentity: [];
  editIdentity: [id: string];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();
const filter = ref<"all" | "running" | "expired">("all");
const query = ref("");

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

const runningCount = computed(() => store.environmentIdentities.filter((i) => store.instanceFor(i.id)).length);
const expiredCount = computed(() => store.environmentIdentities.filter((i) => i.status === "expired").length);
const isProd = computed(() => isProductionName(store.activeEnvironment?.name));

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
  if (isProd.value) {
    const confirmed = window.confirm(
      t("app.prodConfirm", { env: store.activeEnvironment?.name, name: identity.name }),
    );
    if (!confirmed) return;
  }
  const instance = store.instanceFor(identity.id);
  if (instance) {
    await store.stopInstance(instance.id);
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
        <button class="btn" type="button" @click="store.launchCleanSession()">
          <Globe :size="13" />
          {{ $t("app.cleanSession") }}
        </button>
        <button class="btn primary" type="button" @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ $t("app.newIdentity") }}
        </button>
      </div>
    </header>

    <div v-if="isProd" class="prod-banner">
      {{ $t("app.prodBanner") }}
    </div>

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
    </div>

    <div class="cards">
      <button
        v-for="identity in visibleIdentities"
        :key="identity.id"
        type="button"
        class="id-card"
        :class="{ running: Boolean(store.instanceFor(identity.id)) }"
        :style="{ '--role': roleVar(identity.color) }"
        @click="store.instanceFor(identity.id) ? launch(identity) : emit('editIdentity', identity.id)"
      >
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
          <span v-if="isProd" class="tag danger">PROD</span>
        </div>

        <div class="pw-row">
          <span class="dots mono">{{ store.identityPasswordSet(identity) ? "••••••••" : "— — — —" }}</span>
          <span class="inherit mono">{{ passwordLabel(identity) }}</span>
        </div>

        <div class="card-actions">
          <span class="launch" @click.stop="launch(identity)">
            <Square v-if="store.instanceFor(identity.id)" :size="10" />
            <Play v-else :size="10" />
            {{ store.instanceFor(identity.id) ? $t("app.stop") : $t("app.launch") }}
          </span>
          <span @click.stop="relogin(identity)">{{ $t("app.relaunch") }}</span>
          <span @click.stop="checkAuth(identity)">{{ $t("app.checkAuth") }}</span>
          <span class="edit" @click.stop="emit('editIdentity', identity.id)">{{ $t("app.edit") }}</span>
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

.prod-banner,
.vault-banner {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius);
  font-size: 11px;
  flex: 0 0 auto;
}

.prod-banner {
  border: 1px solid color-mix(in srgb, var(--red) 40%, var(--line));
  background: color-mix(in srgb, var(--red) 9%, transparent);
  color: color-mix(in srgb, var(--red) 82%, var(--text));
}

.vault-banner {
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: color-mix(in srgb, var(--accent) 78%, var(--text));
}

.toolbar {
  display: flex;
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
  color: var(--faint);
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

.tag.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--line));
  background: color-mix(in srgb, var(--red) 8%, transparent);
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
  gap: 12px;
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
