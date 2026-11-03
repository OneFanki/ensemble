<script setup lang="ts">
import type { Identity, Site } from "@shared/types";
import { ChevronRight, FilePlus, Globe, ShieldOff } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/**
 * The account chooser: "new page, as whom?".
 *
 * Sites are the bookmarks: open one in the daily profile, open it clean, or open
 * it as one of its accounts. "Daily" is the default *meaning* of a bookmark in an
 * ordinary browser — the login is already there — but it is not the default
 * *action* here: nothing is created until a row is picked. A bare "+" used to
 * produce a daily-profile page every time, which inside a view meant an
 * anonymous page in a grid of accounts.
 *
 * `lockedSiteId` narrows the chooser to one system, which is what a view's own
 * "+" needs: the container already says which system this is, so offering every
 * site in the workspace would be a second sites page inside a 260px dock.
 *
 * Tags are deliberately not shown here: a lone tag name at the bottom of the
 * account column reads as an empty section, and tags are for finding things on
 * the sites page rather than for picking a login.
 */
const props = defineProps<{
  sites: Site[];
  identities: Identity[];
  /** Show only this site's rows; the site column and the search box disappear. */
  lockedSiteId?: string;
}>();

const emit = defineEmits<{
  /** The explicit "no account" choice: a blank page in the daily profile. */
  openBlank: [];
  /** Open the site in the daily profile, reusing whatever login it has. */
  openDaily: [siteId: string];
  /** Open the site in a throwaway session. */
  openClean: [siteId: string];
  /** Open the site as one identity (its own profile). */
  openIdentity: [identityId: string];
}>();

const { t } = useI18n();
const activeSiteId = ref<string | null>(null);
const term = ref("");

const locked = computed(() =>
  props.lockedSiteId ? props.sites.find((site) => site.id === props.lockedSiteId) : undefined,
);

const filtered = computed(() => {
  const available = locked.value ? [locked.value] : props.sites;
  const needle = term.value.trim().toLowerCase();
  if (!needle) return available;
  return available.filter(
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

function openDaily(site: Site): void {
  emit("openDaily", site.id);
}

function openClean(site: Site): void {
  emit("openClean", site.id);
}

function openIdentity(identity: Identity): void {
  emit("openIdentity", identity.id);
}
</script>

<template>
  <div class="open-menu" :class="{ locked }" role="menu" :aria-label="t('app.newPageAs')">
    <div class="head">
      <span class="title">{{ locked ? locked.name : t("app.newPageAs") }}</span>
      <!-- A locked chooser has one system and a handful of accounts; a search
           field there would be a control with nothing to filter. -->
      <input
        v-if="!locked"
        v-model="term"
        class="search"
        type="search"
        :placeholder="t('app.search')"
      />
    </div>

    <div v-if="!filtered.length" class="empty">{{ t("app.emptySites") }}</div>

    <div v-else class="body">
      <div v-if="!locked" class="sites">
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
        <!--
          Opening the site itself: these two belong to the selected site, so they
          stay at the top of its column.
        -->
        <button type="button" class="account-row anonymous" @click="openDaily(activeSite)">
          <Globe :size="11" />
          <span class="acc-copy">
            <span class="acc-name">{{ t("app.openSiteDaily") }}</span>
            <span class="acc-note">{{ t("app.openSiteDailyHint") }}</span>
          </span>
        </button>
        <button type="button" class="account-row anonymous dashed" @click="openClean(activeSite)">
          <ShieldOff :size="11" />
          <span class="acc-copy">
            <span class="acc-name">{{ t("app.openSiteClean") }}</span>
            <span class="acc-note">{{ t("app.openSiteCleanHint") }}</span>
          </span>
        </button>

        <div class="accounts-sep"></div>
        <p class="accounts-title">{{ t("app.openSiteAccounts") }}</p>
        <div class="accounts-list">
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

    <!--
      A blank page belongs to no site, so it sits outside both columns, under its
      own rule. Inside the account column it read as "the fourth thing you can
      open in 后台管理", which is the one thing it is not — the empty page is what
      you get when you want none of the above.
    -->
    <div class="foot">
      <button type="button" class="account-row anonymous plain" @click="emit('openBlank')">
        <FilePlus :size="11" />
        <span class="acc-copy">
          <span class="acc-name">{{ t("app.openBlankPage") }}</span>
          <span class="acc-note">{{ t("app.openBlankPageHint") }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.open-menu {
  /* Wide enough for the two-column chooser; a locked chooser drops the site
     column, so it narrows with it instead of leaving an empty gutter. */
  width: 400px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  overflow: hidden;
}

.open-menu.locked {
  width: 250px;
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
  /* Takes the height the footer leaves, so the account list is the only thing
     that has to scroll. */
  flex: 1 1 auto;
}

/* The blank-page row lives below both columns: it belongs to no site. */
.foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--line-soft);
  padding: 5px;
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
  /* Fixed rows above, scrolling accounts below: a site with thirty accounts must
     not push "open daily" out of the panel. */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 5px;
  min-width: 0;
}

.accounts-list {
  min-height: 0;
  overflow-y: auto;
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

/* The anonymous rows are a different kind of answer from an account pick, so a
   rule separates them. They keep a quiet shape: an account is the common case
   and must stay the loudest row in this column. */
.accounts-sep {
  height: 1px;
  margin: 6px 7px;
  background: var(--line-soft);
}

.account-row.anonymous {
  color: var(--text-secondary);
}

.account-row.anonymous:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* A throwaway session is not the ordinary open, so it is drawn differently —
   dashed instead of plain. Same distinction the two rows had before, now at the
   bottom where they belong. */
.account-row.dashed {
  border: 1px dashed var(--line);
}

/* The blank page sits outside the site columns; it gets no dashed or tinted
   treatment because it is not a special case of opening a site at all. */
.account-row.plain {
  color: var(--muted);
}

.account-row.plain:hover {
  background: var(--surface-2);
  color: var(--text);
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
