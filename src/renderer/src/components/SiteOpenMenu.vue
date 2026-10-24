<script setup lang="ts">
import type { Identity, Site } from "@shared/types";
import { ChevronRight, Globe, Plus } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/**
 * A bookmark-style "open from a site" menu.
 *
 * Sites are the bookmarks: open one clean, or open it as one of its accounts.
 * The account path is what makes this different from typing the URL — the page
 * lands in that identity's own session partition, so the login is already there.
 *
 * Tags are deliberately not shown here: a lone tag name at the bottom of the
 * account column reads as an empty section, and tags are for finding things on
 * the sites page rather than for picking a login.
 */
const props = defineProps<{
  sites: Site[];
  identities: Identity[];
}>();

const emit = defineEmits<{
  /** Open the site's login page in a clean session. */
  openSite: [siteId: string];
  /** Open the site as one identity (its own profile). */
  openIdentity: [identityId: string];
}>();

const { t } = useI18n();
const activeSiteId = ref<string | null>(null);
const term = ref("");

const filtered = computed(() => {
  const needle = term.value.trim().toLowerCase();
  if (!needle) return props.sites;
  return props.sites.filter(
    (site) =>
      site.name.toLowerCase().includes(needle) || site.baseUrl.toLowerCase().includes(needle),
  );
});

const activeSite = computed(
  () => filtered.value.find((site) => site.id === activeSiteId.value) ?? filtered.value[0],
);

const accounts = computed(() => {
  const site = activeSite.value;
  if (!site) return [];
  return props.identities.filter((identity) => identity.siteId === site.id);
});

function openSite(site: Site): void {
  emit("openSite", site.id);
}

function openIdentity(identity: Identity): void {
  emit("openIdentity", identity.id);
}
</script>

<template>
  <div class="open-menu" role="menu" :aria-label="t('app.openFromSite')">
    <div class="head">
      <span class="title">{{ t("app.openFromSite") }}</span>
      <input v-model="term" class="search" type="search" :placeholder="t('app.search')" />
    </div>

    <div v-if="!sites.length" class="empty">{{ t("app.emptySites") }}</div>

    <div v-else class="body">
      <div class="sites">
        <button
          v-for="site in filtered"
          :key="site.id"
          type="button"
          class="site-row"
          :class="{ active: site.id === activeSite?.id }"
          @click="activeSiteId = site.id"
        >
          <Globe :size="11" class="site-icon" />
          <span class="site-copy">
            <span class="site-name">{{ site.name }}</span>
            <span class="site-url mono">{{ site.baseUrl }}</span>
          </span>
          <ChevronRight :size="11" class="chev" />
        </button>
        <p v-if="!filtered.length" class="empty">{{ t("app.noMatchingSites") }}</p>
      </div>

      <div v-if="activeSite" class="accounts">
        <button type="button" class="account-row clean" @click="openSite(activeSite)">
          <Plus :size="11" />
          <span class="acc-copy">
            <span class="acc-name">{{ t("app.openSiteClean") }}</span>
            <span class="acc-note">{{ t("app.openSiteCleanHint") }}</span>
          </span>
        </button>
        <p class="accounts-title">{{ t("app.openSiteAccounts") }}</p>
        <button
          v-for="identity in accounts"
          :key="identity.id"
          type="button"
          class="account-row"
          :style="{ '--role': `var(--role-${identity.color})` }"
          @click="openIdentity(identity)"
        >
          <span class="acc-dot"></span>
          <span class="acc-copy">
            <span class="acc-name">{{ identity.name }}</span>
            <span class="acc-note mono">{{ identity.username }}</span>
          </span>
        </button>
        <p v-if="!accounts.length" class="empty">{{ t("app.openSiteNoAccounts") }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.open-menu {
  width: 400px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 18px 40px rgb(0 0 0 / 48%);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

.title {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
  white-space: nowrap;
}

.search {
  margin-left: auto;
  width: 150px;
  height: 24px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 0 8px;
  font-size: 11px;
  color: var(--text);
  outline: 0;
}

.search:focus {
  border-color: var(--line);
}

.body {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  min-height: 0;
}

.sites {
  border-right: 1px solid var(--line-soft);
  overflow-y: auto;
  padding: 5px;
}

.site-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 7px;
  border-radius: var(--radius-sm);
  /* The active row is carried by the left rule as well as the fill: with a list
     of near-identical rows, a subtle background alone is easy to miss. */
  box-shadow: inset 2px 0 0 transparent;
  color: var(--muted);
  text-align: left;
}

.site-row:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.site-row.active {
  background: var(--surface-3);
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--text);
}

.site-row.active .chev {
  color: var(--accent);
}

.site-icon,
.chev {
  flex: 0 0 auto;
  color: var(--faint);
}

.site-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.site-name {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-url {
  font-size: 9.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accounts {
  overflow-y: auto;
  padding: 5px;
  min-width: 0;
}

.accounts-title {
  margin: 8px 7px 3px;
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.account-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-align: left;
}

.account-row:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

/* A clean open is a different kind of action from picking an account, so it is
   drawn as one: dashed outline instead of a row in the same list. */
.account-row.clean {
  border: 1px dashed var(--line);
  margin-bottom: 2px;
  color: var(--text-secondary);
}

.acc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--role, var(--accent));
  flex: 0 0 6px;
}

.acc-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.acc-name {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acc-note {
  font-size: 9.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 12px 10px;
  font-size: 10.5px;
  color: var(--faint);
  text-align: center;
}
</style>
