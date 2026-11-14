<script setup lang="ts">
import type { BrowserProfile, Identity, Site } from "@shared/types";
import { ChevronRight, Globe, Layers, ShieldOff } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/**
 * The new-browser chooser: "a browser, as what?".
 *
 * Two modes, because the two reasons to open a browser are different questions:
 *
 * - **Account** (the default): the user knows which login they need. Pick the
 *   system on the left, then the account on the right. The site's own openings —
 *   its default profile and a throwaway — sit above the accounts so a site with
 *   thirty accounts never pushes them out of view.
 * - **Profile**: the user does not want a particular login, they want an empty
 *   browser in a particular cookie jar and will find the site afterwards (usually
 *   from a bookmark). Clicking a profile opens a blank page in it.
 *
 * Accounts and profiles are not the same axis, which is why they are two lists
 * rather than one merged one: an account *is* a profile, but it also carries a
 * system, credentials and a start page — and the account list is only meaningful
 * once a system is chosen.
 *
 * `lockedSiteId` narrows the chooser to one system, which is what a view's own
 * "+" needs: the container already says which system this is.
 *
 * The profile list is read-only here on purpose. Creating and renaming profiles
 * is a management task and lives on the profiles page; a create form inside a
 * 400px popover would be one more thing competing with the list it belongs to.
 */
const props = defineProps<{
  sites: Site[];
  identities: Identity[];
  profiles: BrowserProfile[];
  /** Profile a page with no account opens in when none is picked. */
  defaultProfileId: string;
  /** Show only this site's rows; the site column and the search box disappear. */
  lockedSiteId?: string;
}>();

const emit = defineEmits<{
  /** Open a blank browser in one profile (its retention decides what survives). */
  openProfile: [profileId: string];
  /** Open the site in the profile used for account-less pages. */
  openDaily: [siteId: string];
  /** Open the site in a throwaway session. */
  openClean: [siteId: string];
  /** Open the site as one identity (its own profile). */
  openIdentity: [identityId: string];
}>();

const { t } = useI18n();
const mode = ref<"accounts" | "profiles">("accounts");
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

/**
 * The jar list, and the throwaway kept apart from it.
 *
 * A profile is something the user names, keeps and manages. The clean session is
 * not: it is one fixed empty jar that forgets everything on quit, so it sits at
 * the bottom as its own opening instead of as a row among jars that persist. The
 * account tab draws it the same way, which is what makes the two tabs agree on
 * what it is.
 */
const persistentProfiles = computed(() =>
  props.profiles.filter((profile) => profile.retention !== "ephemeral"),
);
const cleanProfile = computed(() =>
  props.profiles.find((profile) => profile.retention === "ephemeral"),
);

/** Only the search box belongs to the account tab; a profile has no address. */
const showSearch = computed(() => !locked.value && mode.value === "accounts");

function openDaily(site: Site): void {
  emit("openDaily", site.id);
}

function openClean(site: Site): void {
  emit("openClean", site.id);
}

function openIdentity(identity: Identity): void {
  emit("openIdentity", identity.id);
}

function openProfile(profile: BrowserProfile): void {
  emit("openProfile", profile.id);
}

/**
 * The two lifetimes, as words a user can act on.
 *
 * Not "persist"/"ephemeral": those name the mechanism. What matters when
 * choosing a row is whether the sign-in is still there tomorrow.
 */
function retentionNote(profile: BrowserProfile): string {
  return profile.retention === "ephemeral"
    ? t("app.profileEphemeralNote")
    : t("app.profilePersistNote");
}
</script>

<template>
  <div class="open-menu" :class="{ locked }" role="menu" :aria-label="t('app.newBrowser')">
    <div class="head">
      <span class="title">{{ t("app.newBrowser") }}</span>
      <!-- Two modes, side by side: an account pick needs a system first, a
           profile pick does not. -->
      <div class="modes" role="tablist">
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'accounts' }"
          role="tab"
          :aria-selected="mode === 'accounts'"
          data-mode="accounts"
          @click="mode = 'accounts'"
        >
          {{ t("app.newBrowserAccounts") }}
        </button>
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'profiles' }"
          role="tab"
          :aria-selected="mode === 'profiles'"
          data-mode="profiles"
          @click="mode = 'profiles'"
        >
          {{ t("app.newBrowserProfiles") }}
        </button>
      </div>
      <input
        v-if="showSearch"
        v-model="term"
        class="search"
        type="search"
        :placeholder="t('app.newBrowserSearch')"
      />
    </div>

    <!-- Accounts: system on the left, its accounts on the right. -->
    <template v-if="mode === 'accounts'">
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
    </template>

    <!-- Profiles: an empty browser in one cookie jar. The clean session is a
         separate opening at the bottom — it is one fixed throwaway, not a jar
         anyone keeps, so it must not read as a row of the same kind. -->
    <div v-else class="profiles">
      <button
        v-for="profile in persistentProfiles"
        :key="profile.id"
        type="button"
        class="account-row profile-row"
        :data-profile-id="profile.id"
        v-tooltip="{ text: retentionNote(profile) }"
        @click="openProfile(profile)"
      >
        <Layers :size="11" class="profile-icon" />
        <span class="acc-name">{{ profile.name }}</span>
        <span v-if="profile.id === defaultProfileId" class="badge">{{ t("app.profileDefaultBadge") }}</span>
      </button>
      <button
        v-if="cleanProfile"
        type="button"
        class="account-row profile-row dashed"
        :data-profile-id="cleanProfile.id"
        v-tooltip="{ text: retentionNote(cleanProfile) }"
        @click="openProfile(cleanProfile)"
      >
        <ShieldOff :size="11" class="profile-icon" />
        <span class="acc-name">{{ cleanProfile.name }}</span>
      </button>
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
 * The mode switch.
 *
 * Two plain labels rather than a segmented control: the panel is small, and a
 * chip inside a chip inside a 420px popover is three nested frames for six
 * characters. The active one takes the text colour and an underline; the other
 * stays quiet until hovered.
 */
.modes {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mode {
  position: relative;
  padding: 4px 6px;
  font-size: 11.5px;
  color: var(--faint);
  border-radius: var(--radius-sm);
}

.mode:hover {
  color: var(--text-secondary);
}

.mode.on {
  color: var(--text);
}

.mode.on::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 0;
  height: 1.5px;
  border-radius: 1px;
  background: var(--accent);
}

.search {
  margin-left: auto;
  /* Narrow enough that the two mode labels and the title keep their space at
     420px; the field only filters sites, which are short names. */
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

.profiles {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 5px;
}

/* One line per profile: the name, and the "default" chip when it is one. What
   the row keeps is on hover — see the account column's comment for why. */
.profile-row {
  padding: 7px;
}

/* The clean session is not a jar among jars, so it is drawn as the account tab
   draws its throwaway: dashed, and last. */
.profile-row.dashed {
  border: 1px dashed var(--line);
}

.profile-row .acc-name {
  flex: 1 1 auto;
}

.profile-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

/* The default marker is a state, not an action: a quiet chip at the row's right
   edge, the same shape the profiles page uses. */
.badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  /* `--selected` is only a shade off `--surface` in the dark theme, which made
     this chip read as a smudge. The strong step plus a hairline is what makes it
     legible as a marker rather than as a rendering artefact. */
  background: var(--selected-strong);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  letter-spacing: 0.02em;
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
