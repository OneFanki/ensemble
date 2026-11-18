<script setup lang="ts">
import type { BrowserProfile, Identity, Site } from "@shared/types";
import { ChevronRight, Globe, ShieldOff } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/**
 * The new-browser chooser: pick whose page this is.
 *
 * An account is the answer the chooser exists for: pick the system on the left,
 * then the account on the right, and the page opens signed in as them. The
 * site's own openings — the default profile and a throwaway — sit above the
 * accounts so a site with thirty accounts never pushes them out of view.
 *
 * `lockedSiteId` narrows the chooser to one system, which is what a view's own
 * "+" needs: the container already says which system this is.
 */
const props = defineProps<{
  sites: Site[];
  identities: Identity[];
  /** Read only for the default profile's name on the site-less opening row. */
  profiles: BrowserProfile[];
  /** Profile a page with no account opens in when none is picked. */
  defaultProfileId: string;
  /** Show only this site's rows; the site column and the search box disappear. */
  lockedSiteId?: string;
}>();

const emit = defineEmits<{
  /** Open the site in the profile used for account-less pages. */
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

const defaultProfile = computed(
  () => props.profiles.find((profile) => profile.id === props.defaultProfileId) ?? props.profiles[0],
);

/** The search box filters systems, which only exists when they are listed. */
const showSearch = computed(() => !locked.value);

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
  <div class="open-menu" :class="{ locked }" role="menu" :aria-label="t('app.newBrowser')">
    <div class="head">
      <span class="title">{{ t("app.newBrowser") }}</span>
      <input
        v-if="showSearch"
        v-model="term"
        class="search"
        type="search"
        :placeholder="t('app.newBrowserSearch')"
      />
    </div>

    <div v-if="locked" class="locked-site">
      <Globe :size="11" />
      <span class="site-name">{{ locked.name }}</span>
    </div>

    <div v-if="!filtered.length" class="empty-line">{{ t("app.emptySites") }}</div>

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
      </div>

      <div v-if="activeSite" class="accounts">
        <!--
          The site's own two openings: no account, so they are about the
          session rather than about a login. They stay fixed above the
          scrolling list — a site with thirty accounts must not push them past
          the fold.

          One line each, with the explanation on hover. "默认档案" and
          "干净会话" already say what they are to anyone who has used the app
          once; a second line repeating it would cost every visit to explain
          something the reader learned the first time.
        -->
        <button
          type="button"
          class="account-row anonymous"
          data-open-daily
          v-tooltip="{ text: t('app.openSiteDailyHint') }"
          @click="openDaily(activeSite)"
        >
          <Globe :size="11" />
          <span class="acc-name">{{ t("app.openSiteDefault", { name: defaultProfile?.name ?? "" }) }}</span>
        </button>
        <button
          type="button"
          class="account-row anonymous dashed"
          data-open-clean
          v-tooltip="{ text: t('app.openSiteCleanHint') }"
          @click="openClean(activeSite)"
        >
          <ShieldOff :size="11" />
          <span class="acc-name">{{ t("app.openSiteClean") }}</span>
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
          <p v-if="!accounts.length" class="empty-line">{{ t("app.openSiteNoAccounts") }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.open-menu {
  /* Wide enough for the two-column chooser; a locked chooser drops the site
     column, so it narrows with it instead of leaving an empty gutter. */
  width: 420px;
  max-height: 400px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  overflow: hidden;
}

.open-menu.locked {
  width: 270px;
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

/*
 * The search box, the header's only other resident now that the chooser asks a
 * single question.
 */
.search {
  margin-left: auto;
  /* Narrow enough that the title keeps its space at 420px; the field only
     filters sites, which are short names. */
  width: 120px;
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

/* A locked chooser names its one system above the accounts instead of drawing a
   column with a single row in it. */
.locked-site {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11.5px;
  color: var(--text-secondary);
  flex: 0 0 auto;
}

.body {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  min-height: 0;
  /* Takes the height the header leaves, so the account list is the only thing
     that has to scroll. */
  flex: 1 1 auto;
}

.sites {
  border-right: 1px solid var(--line-soft);
  overflow-y: auto;
  padding: 5px;
}

.site-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 7px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-align: left;
}

/*
 * The selected row's left rule.
 *
 * It used to be `box-shadow: inset 2px 0 0 var(--accent)`, which follows the
 * element's rounded corner — so instead of a straight edge it drew a two-pixel
 * arc curving around the corner, reading as a stray bracket rather than as a
 * marker. A separate square element inside the row is the shape that was wanted:
 * a straight rule with no radius of its own, clipped by the row's corners.
 */
.site-row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 1px;
  background: transparent;
}

.site-row:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.site-row.active {
  background: var(--surface-3);
  color: var(--text);
}

.site-row.active::before {
  background: var(--accent);
}

.site-row.active .chev {
  color: var(--accent-text);
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
   dashed instead of plain. */
.account-row.dashed {
  border: 1px dashed var(--line);
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

.empty-line {
  padding: 12px 10px;
  font-size: 10.5px;
  color: var(--faint);
  text-align: center;
}
</style>
