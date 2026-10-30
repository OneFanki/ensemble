<script setup lang="ts">
import type {
  IdentityDraft,
  LayoutPreset,
  LoginCaptureNotice,
  SiteDraft,
  SlotRect,
  ViewDraft,
} from "@shared/types";
import type { UpdateCheckResult } from "@shared/update";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Bot } from "lucide-vue-next";
import BrowserPage from "./components/BrowserPage.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import FlowsPage from "./components/FlowsPage.vue";
import IdentitiesPage from "./components/IdentitiesPage.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import LoginCaptureBar from "./components/LoginCaptureBar.vue";
import Logo from "./components/Logo.vue";
import RunDock from "./components/RunDock.vue";
import SessionHealthDialog from "./components/SessionHealthDialog.vue";
import SettingsPage from "./components/SettingsPage.vue";
import SideRail from "./components/SideRail.vue";
import SiteDialog from "./components/SiteDialog.vue";
import SitesPage from "./components/SitesPage.vue";
import SpotlightTour from "./components/SpotlightTour.vue";
import TagsPage from "./components/TagsPage.vue";
import TitleBar from "./components/TitleBar.vue";
import ToastStack from "./components/ToastStack.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import ViewDialog from "./components/ViewDialog.vue";
import ViewsPage from "./components/ViewsPage.vue";
import { type Locale, setLocale, tr } from "./i18n";
import { type LocaleSetting, resolveLocale } from "@shared/locale";
import {
  shouldAutoStartTour,
  TOUR_STEPS,
  TOUR_VERSION,
  type TourView,
} from "./onboarding/tourSteps";
import { useConfirmStore } from "./stores/confirm";
import { useEmbeddedStore } from "./stores/embedded";
import { useWorkspaceStore } from "./stores/workspace";

type View = "browser" | "sites" | "identities" | "views" | "flows" | "tags" | "settings";

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const view = ref<View>("browser");
const siteDraft = ref<SiteDraft | null>(null);
const identityDraft = ref<IdentityDraft | null>(null);
const viewDraft = ref<ViewDraft | null>(null);
const layoutEditor = ref<{ preset?: LayoutPreset; seed?: SlotRect[]; viewId?: string } | null>(
  null,
);
const tourOpen = ref(false);
const tourOriginView = ref<View>("browser");
/** Remount the tour on replay so it cannot keep the previous step index. */
const tourSession = ref(0);
const healthOpen = ref(false);
/** True while an HTML overlay covers the browser stage. */
const stageObscured = ref(false);
/** Seed for the account form's inline site creator, from a captured login. */
const identitySiteSeed = ref<{ origin: string; path: string } | null>(null);
/** Set by a background check, or by the manual check in Settings. */
const updatePrompt = ref<UpdateCheckResult | null>(null);

const platform = computed(() => store.snapshot?.platform ?? "win32");

/**
 * The language actually rendered: `settings.locale` with "system" resolved.
 *
 * Resolved here rather than in the store because both the initial call and the
 * settings-page switch need it, and the system tag arrives with the snapshot.
 */
const resolvedLocale = computed<Locale>(() =>
  resolveLocale(store.settings.locale, store.snapshot?.systemLocale),
);

// "system" has to follow a change of the OS language mid-session too. Electron
// does not deliver that on Windows, so this only guards the common case of the
// setting itself changing (picking 简体中文 / English / 跟随系统 in settings).
watch(resolvedLocale, (next) => setLocale(next));

/**
 * Native pages paint above every piece of app HTML, so any modal that covers
 * the stage has to freeze it first. Missing one dialog is not a cosmetic bug:
 * the dialog renders behind a live page and looks broken.
 */
const overlayOpen = computed(
  () =>
    stageObscured.value ||
    Boolean(
      confirm.current ||
        siteDraft.value ||
        identityDraft.value ||
        viewDraft.value ||
        layoutEditor.value ||
        healthOpen.value ||
        updatePrompt.value ||
        tourOpen.value,
    ),
);

onMounted(async () => {
  await store.init();
  await embedded.init();
  // The status bar shows the endpoint on every screen, so it has to be known
  // before the first settings visit.
  void store.mcpStatus();
  applyTheme(store.settings.theme);
  setLocale(resolvedLocale.value);  const saved = store.settings.lastView;
  // The browser is the default page; returning to where the user left off beats
  // resetting them to a management page they only visited once.
  view.value =
    saved === "sites" ||
    saved === "identities" ||
    saved === "views" ||
    saved === "flows" ||
    saved === "tags" ||
    saved === "browser"
      ? saved
      : "browser";
  // The main process asks for the browser page when a tool or a shortcut opens a
  // page in it, so the result is never hidden behind a management page. Already
  // being there is the common case (a tab click inside the browser page), and
  // re-entering the view would persist the same setting on every click.
  window.ensemble.onEmbeddedPage(() => {
    if (view.value !== "browser") switchView("browser");
  });
  if (shouldAutoStartTour(store.settings)) {
    tourOriginView.value = view.value;
    window.setTimeout(() => {
      tourOpen.value = true;
    }, 350);
  }
  // The main process restores the last view itself; the renderer only reports it
  // so the user knows why several windows just appeared.
  window.ensemble.onViewRestored((outcome) => {
    if (outcome.restored) {
      store.notify(tr("app.toastViewRestored", { name: outcome.viewName ?? "" }), "success");
    } else if (outcome.reason) {
      store.notify(tr("app.toastViewRestoreFailed", { reason: outcome.reason }), "error");
    }
  });
  // Background checks stay silent until they find something; the dialog also
  // opens from the manual check in Settings, which emits the same event.
  window.ensemble.onUpdateAvailable((result) => {
    updatePrompt.value = result;
  });
});

function applyTheme(theme: "dark" | "light" | "system") {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset["theme"] = resolved;
}

/**
 * `prefers-color-scheme` changes when the OS switches appearance while the
 * setting is "system". Re-resolve it here so the window follows without a
 * restart; explicit dark/light settings must ignore the event.
 */
function handleSystemThemeChange() {
  if (store.settings.theme === "system") applyTheme("system");
}

const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
systemTheme.addEventListener("change", handleSystemThemeChange);
onUnmounted(() => systemTheme.removeEventListener("change", handleSystemThemeChange));

function switchView(next: View) {
  view.value = next;
  if (next !== "settings") {
    void store.saveSettings({ lastView: next });
  }
}

/** Which settings tab a status-bar entry point should land on. */
const settingsTab = ref<"general" | "engines" | "vault" | "data" | "mcp" | "about">("general");
/**
 * Bumped on every navigation request.
 *
 * The settings page is not remounted between visits, so the tab alone is not
 * enough: clicking the entry twice, with a manual tab change in between, would
 * leave the prop unchanged and the page would stay where the user put it.
 */
const settingsTabSeq = ref(0);

/**
 * Status-bar shortcut into Settings → AI access.
 *
 * Retargets the tab every time: the settings page keeps its own active tab
 * across visits, so a plain `view = "settings"` would land on whatever was open
 * last and leave the user hunting for the endpoint address.
 */
function openMcpSettings() {
  settingsTab.value = "mcp";
  settingsTabSeq.value += 1;
  view.value = "settings";
}
function startTour() {
  tourOriginView.value = view.value;
  tourSession.value += 1;
  tourOpen.value = true;
}

async function finishTour(completed: boolean) {
  tourOpen.value = false;
  if (!completed) view.value = tourOriginView.value;
  if ((store.settings.onboardingVersion ?? 0) < TOUR_VERSION) {
    await store.saveSettings({ onboardingVersion: TOUR_VERSION });
  }
}

function handleTourNavigate(next: TourView) {
  view.value = next;
}

function openNewSite(seed?: Partial<SiteDraft>) {
  siteDraft.value = {
    name: "",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    authCheckPath: "",
    authCheckSignedOut: "",
    // No opinion: follow the global setting until someone decides otherwise.
    autoSubmit: undefined,
    tagIds: [],
    ...seed,
  };
}

/** Opens a site's login page in the built-in browser as a fresh page. */
async function openSite(siteId: string) {
  const site = store.sites.find((item) => item.id === siteId);
  if (!site) return;
  let url: string;
  try {
    url = new URL(site.loginPath || "/", site.baseUrl).toString();
  } catch {
    store.notify(tr("app.errSiteUrl"), "error");
    return;
  }
  store.markSiteUsed(site.id);
  await embedded.openTabWith(url);
  view.value = "browser";
}

function openEditSite(siteId?: string) {
  const env = siteId ? store.sites.find((item) => item.id === siteId) : store.defaultSite;
  if (!env) return;
  siteDraft.value = {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    loginPath: env.loginPath,
    authCheckPath: env.authCheckPath ?? "",
    authCheckSignedOut: env.authCheckSignedOut ?? "",
    autoSubmit: env.autoSubmit,
    tagIds: env.tagIds ? [...env.tagIds] : [],
  };
}

/**
 * New identity starts on the most recently used site.
 *
 * The form can create a site inline, so having no sites is no longer a dead end
 * that sends the user to another page first.
 */
function openNewIdentity(siteId?: string) {
  const site = siteId ? store.sites.find((item) => item.id === siteId) : store.defaultSite;
  identityDraft.value = {
    siteId: site?.id ?? "",
    name: "",
    username: "",
    role: "admin",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/",
    extraFields: [],
    tagIds: [],
  };
}

function openEditIdentity(identityId: string) {
  const identity = store.identities.find((item) => item.id === identityId);
  if (!identity) return;
  identityDraft.value = {
    id: identity.id,
    // An account with no site opens the form on "pick a site", which is the
    // first thing that has to be fixed before it can log in anywhere.
    siteId: identity.siteId ?? "",
    name: identity.name,
    username: identity.username,
    role: identity.role,
    color: identity.color,
    engineId: identity.engineId,
    startPath: identity.startPath,
    passwordMode: identity.passwordMode,
    ...(identity.credentialFrom ? { credentialFrom: identity.credentialFrom } : {}),
    extraFields: identity.extraFields ? identity.extraFields.map((field) => ({ ...field })) : [],
    tagIds: identity.tagIds ? [...identity.tagIds] : [],
    note: identity.note,
  };
}

/**
 * A new view starts with members from the most recently used site, but the
 * dialog lists every identity — a view is one screen, not one deployment.
 *
 * `seed` is how a batch selection becomes a saved view: the accounts come in
 * already chosen, and the rest of the form (name, layout, tags) is the normal
 * new-view experience. The home site follows the first member so a cross-site
 * selection still lands on a real site instead of the last-used one.
 */
function openNewView(seed?: { identityIds: string[] }) {
  const site = store.defaultSite;
  const seeded = seed?.identityIds.filter((id) => store.identities.some((item) => item.id === id));
  const firstMemberSite = seeded?.length
    ? store.identities.find((item) => item.id === seeded[0])?.siteId
    : undefined;
  viewDraft.value = {
    siteId: firstMemberSite ?? site?.id ?? store.sites[0]?.id ?? "",
    name: "",
    identityIds:
      seeded && seeded.length > 0
        ? seeded
        : site
          ? store
              .identitiesOf(site.id)
              .slice(0, 3)
              .map((item) => item.id)
          : [],
    layoutId: store.settings.layout,
    slotAssignments: {},
    paths: {},
    tagIds: [],
  };
}
function openEditView(viewId: string) {
  const view = store.views.find((item) => item.id === viewId);
  if (!view) return;
  viewDraft.value = {
    id: view.id,
    siteId: view.siteId,
    name: view.name,
    identityIds: [...view.identityIds],
    layoutId: view.layoutId,
    slotAssignments: { ...view.slotAssignments },
    paths: { ...view.paths },
    tagIds: view.tagIds ? [...view.tagIds] : [],
  };
}

async function saveSite(draft: SiteDraft) {
  const result = await store.saveSite(draft);
  if (result) {
    siteDraft.value = null;
    const saved = draft.id
      ? result.sites.find((item) => item.id === draft.id)
      : result.sites.find((item) => item.name === draft.name);
    if (saved) store.markSiteUsed(saved.id);
  }
}

async function saveIdentity(draft: IdentityDraft) {
  const result = await store.saveIdentity(draft);
  if (result) {
    identityDraft.value = null;
    // The captured password is consumed on save; the prompt must not linger.
    if (draft.captureToken) store.clearLoginCapture();
  }
}

/**
 * Opens the account form pre-filled from a captured login.
 *
 * The site is matched by origin when one exists; otherwise the form opens with
 * an inline "create this site" suggestion already filled, so the user does not
 * have to leave and come back.
 */
function saveCapturedLogin(notice: LoginCaptureNotice): void {
  const site = notice.siteId ? store.sites.find((item) => item.id === notice.siteId) : undefined;
  const existing = store.identities.find(
    (identity) =>
      identity.username.toLowerCase() === notice.username.toLowerCase() &&
      (!site || identity.siteId === site.id),
  );
  if (existing) {
    // Same account seen again: updating the password is the only sensible action;
    // a second identity for one login would split its session in two.
    identityDraft.value = {
      id: existing.id,
      siteId: existing.siteId ?? "",
      name: existing.name,
      username: existing.username,
      role: existing.role,
      color: existing.color,
      engineId: existing.engineId,
      startPath: existing.startPath,
      passwordMode: "custom",
      extraFields: existing.extraFields ? existing.extraFields.map((field) => ({ ...field })) : [],
      tagIds: existing.tagIds ? [...existing.tagIds] : [],
      note: existing.note,
      captureToken: notice.token,
    };
    return;
  }
  identityDraft.value = {
    siteId: site?.id ?? "",
    name: notice.username,
    username: notice.username,
    role: "member",
    color: "teal",
    passwordMode: "custom",
    startPath: notice.path || "/",
    extraFields: [],
    tagIds: [],
    captureToken: notice.token,
  };
  // No matching site: the form opens on its inline site creator, prefilled with
  // the origin, so the password is not dropped just because the site is new.
  if (!site) {
    identitySiteSeed.value = { origin: notice.origin, path: notice.path };
  }
}

/**
 * Creates a site from inside the identity form and keeps the draft.
 *
 * The dialog asks the shell because saving a site is a workspace action; the
 * account form should not submit a half-filled site on its own. Everything the
 * user already typed stays, only the site id changes.
 */
async function createSiteFromIdentity(input: { name: string; baseUrl: string }) {
  const draft = identityDraft.value;
  if (!draft) return;
  const result = await store.saveSite({
    name: input.name,
    baseUrl: input.baseUrl,
    loginPath: "/login",
    autoSubmit: undefined,
  });
  if (!result) return;
  const saved = result.sites.find((item) => item.name === input.name);
  if (!saved) return;
  store.markSiteUsed(saved.id);
  identityDraft.value = { ...draft, siteId: saved.id };
}

async function saveView(draft: ViewDraft) {
  const result = await store.saveView(draft);
  if (result) viewDraft.value = null;
}

async function deleteView(viewId: string) {
  const accepted = await confirm.ask({
    title: tr("app.delete"),
    body: tr("app.deleteViewConfirm"),
    confirmLabel: tr("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteView(viewId);
}

async function deleteSite(siteId: string) {
  await store.deleteSite(siteId);
  siteDraft.value = null;
}

function openLayoutEditor(preset?: LayoutPreset, viewId?: string) {
  // Built-in presets cannot be edited in place, so customizing one seeds a new
  // preset with its geometry instead of cloning the id.
  const editablePreset = preset && !preset.builtin ? preset : undefined;
  const seed = preset?.slots.map((slot) => ({ ...slot }));
  layoutEditor.value = {
    ...(editablePreset ? { preset: editablePreset } : {}),
    ...(viewId ? { viewId } : {}),
    seed:
      seed && seed.length > 0
        ? seed
        : store.presetById(store.settings.layout).slots.map((slot) => ({ ...slot })),
  };
}

async function saveLayout(draft: { id?: string; name: string; slots: SlotRect[] }) {
  const viewId = layoutEditor.value?.viewId;
  const saved = await store.saveLayoutPreset(draft);
  if (!saved) return;
  layoutEditor.value = null;
  // When the editor was opened from a view, switch that view to the new preset
  // right away; otherwise the user would save a layout and see nothing change.
  if (viewId) await store.setViewLayout(viewId, saved.id);
}

async function deleteLayout(preset: LayoutPreset) {
  const accepted = await confirm.ask({
    title: tr("app.delete"),
    body: tr("app.confirmDeleteLayout", { name: preset.name }),
    confirmLabel: tr("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteLayoutPreset(preset.id);
  layoutEditor.value = null;
}

async function handleTheme(theme: "dark" | "light" | "system") {
  // Switch the native source before resolving "system": until the main process
  // updates themeSource, prefers-color-scheme still reflects the old forced theme.
  await window.ensemble.setTheme(theme);
  await store.saveSettings({ theme });
  applyTheme(theme);
}

async function handleLocale(locale: LocaleSetting) {
  await store.saveSettings({ locale });
}
</script>

<template>
  <div class="app-shell" :data-platform="platform">
    <TitleBar
      @manage-sites="switchView('sites')"
      @menu-open="(open) => (stageObscured = open)"
    />

    <div v-if="store.loading" class="boot">
      <Logo :size="30" />
      <span class="boot-copy">
        <span class="boot-name">Ensemble</span>
        <span class="boot-hint">{{ $t("app.bootHint") }}</span>
      </span>
    </div>

    <div v-else class="app-body" :class="{ 'settings-mode': view === 'settings' }">
      <SideRail :view="view" @navigate="switchView" />

      <main class="main-pane">
        <BrowserPage v-if="view === 'browser'" :obscured="overlayOpen" />
        <SitesPage
          v-else-if="view === 'sites'"
          @new-site="openNewSite"
          @edit-site="openEditSite"
          @open-site="openSite"
        />
        <IdentitiesPage
          v-else-if="view === 'identities'"
          @new-identity="openNewIdentity"
          @edit-identity="openEditIdentity"
          @session-health="healthOpen = true"
          @create-view="openNewView({ identityIds: $event })"
        />
        <ViewsPage
          v-else-if="view === 'views'"
          @new-view="openNewView"
          @edit-view="openEditView"
          @delete-view="deleteView"
          @edit-layout="openLayoutEditor"
        />
        <FlowsPage v-else-if="view === 'flows'" />
        <TagsPage v-else-if="view === 'tags'" />
        <SettingsPage
          v-else
          :tab="settingsTab"
          :tab-seq="settingsTabSeq"
          @theme="handleTheme"
          @locale="handleLocale"
          @start-tour="startTour"
          @update-found="(result) => (updatePrompt = result)"
        />
      </main>

      <RunDock v-if="view !== 'settings'" />
    </div>

    <footer class="statusbar mono">
      <span class="status-group">
        <span class="led" :class="{ idle: !store.instances.length && !embedded.tabs.length }"></span>
        {{
          store.instances.length || embedded.tabs.length
            ? $t("app.statusConnected")
            : $t("app.statusReady")
        }}
      </span>
      <span>{{ $t("app.instancesCount", { count: store.instances.length + embedded.tabs.length }) }}</span>
      <span class="status-right">
        <!-- Every screen needs the endpoint address, and copying it should not
             mean hunting through settings. The dot carries the on/off state on
             its own, so no extra words are needed when it is off; when it is on,
             the label names the feature and the port says where. -->
        <button
          type="button"
          class="status-mcp"
          :class="{ on: store.mcp?.running }"
          :title="$t('app.statusMcpHint')"
          @click="openMcpSettings"
        >
          <Bot :size="12" />
          <span class="mcp-led" :class="{ on: store.mcp?.running }"></span>
          <span class="mcp-label">{{ $t("app.mcpAiAccess") }}</span>
          <span v-if="store.mcp?.running" class="mcp-port">:{{ store.mcp.port }}</span>
        </button>
        <span>v{{ store.snapshot?.appVersion ?? "0.1.0" }}</span>
      </span>
    </footer>

    <!-- A login seen in an embedded page. Floating above the dock so it never
         covers the page the user is still working in, and never takes a row in
         the app grid — it is a prompt, not part of the layout. -->
    <div v-if="store.loginCapture" class="capture-wrap">
      <LoginCaptureBar
        :notice="store.loginCapture"
        :site-name="store.sites.find((s) => s.id === store.loginCapture?.siteId)?.name"
        @save="saveCapturedLogin"
        @dismiss="store.dismissLoginCapture"
      />
    </div>

    <ToastStack />
    <ConfirmDialog />

    <SiteDialog
      v-if="siteDraft"
      :draft="siteDraft"
      :tags="store.snapshot?.tags ?? []"
      @close="siteDraft = null"
      @save="saveSite"
      @delete="deleteSite(siteDraft!.id!)"
    />

    <IdentityDialog
      v-if="identityDraft"
      :draft="identityDraft"
      :engines="store.engines"
      :site-seed="identitySiteSeed"
      :password-set="identityDraft.id ? store.identityPasswordSet(store.identities.find(i => i.id === identityDraft!.id)!) : false"
      @close="identityDraft = null; identitySiteSeed = null"
      @save="saveIdentity"
      @create-site="createSiteFromIdentity"
      @delete="store.deleteIdentity(identityDraft!.id!); identityDraft = null"
    />

    <ViewDialog
      v-if="viewDraft"
      :draft="viewDraft"
      :identities="store.identities"
      :sites="store.sites"
      :presets="store.viewLayoutPresets"
      :tags="store.snapshot?.tags ?? []"
      @close="viewDraft = null"
      @save="saveView"
      @delete="store.deleteView(viewDraft!.id!); viewDraft = null"
    />

    <SessionHealthDialog v-if="healthOpen" @close="healthOpen = false" />

    <UpdateDialog
      v-if="updatePrompt"
      :result="updatePrompt"
      @dismissed="(version) => store.saveSettings({ dismissedUpdateVersion: version })"
      @close="updatePrompt = null"
    />

    <LayoutEditor
      v-if="layoutEditor"
      :preset="layoutEditor.preset"
      :seed="layoutEditor.seed"
      @close="layoutEditor = null"
      @save="saveLayout"
      @delete="layoutEditor.preset ? deleteLayout(layoutEditor.preset) : null"
    />

    <SpotlightTour
      :key="tourSession"
      :open="tourOpen"
      :steps="TOUR_STEPS"
      @navigate="handleTourNavigate"
      @close="finishTour"
    />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: grid;
  grid-template-rows: var(--titlebar-height) minmax(0, 1fr) 30px;
  background:
    radial-gradient(1100px 420px at 78% -12%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 62%),
    radial-gradient(800px 380px at 12% 105%, color-mix(in srgb, var(--green) 5%, transparent), transparent 60%),
    var(--bg);
}

.boot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.boot-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.boot-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.boot-hint {
  font-size: 10.5px;
  color: var(--faint);
}

.app-body {
  min-height: 0;
  display: grid;
  /* The rail collapses to an icon strip and the dock to a badge, so both sides
     size to their own content instead of to a fixed column. */
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.app-body.settings-mode {
  grid-template-columns: auto minmax(0, 1fr);
}

.main-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 13px;
  border-top: 1px solid var(--line-soft);  background: color-mix(in srgb, var(--bg) 88%, black);
  color: var(--faint);
  font-size: 10.5px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
}

/*
 * The capture prompt floats over the app, dock included.
 *
 * It used to be a plain child of the shell grid, which added an implicit fourth
 * row and shifted the whole layout every time a login was submitted. Fixed
 * positioning keeps it a prompt: no reflow, no reserved space.
 */
.capture-wrap {
  position: fixed;
  z-index: 100;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  width: min(520px, calc(100vw - 48px));
}

.status-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.led {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px color-mix(in srgb, var(--green) 70%, transparent);
}

.led.idle {
  background: var(--faint);
  box-shadow: none;
}

/* AI access entry: one click to the endpoint address, the dot is live state. */
.status-mcp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--faint);
  font: inherit;
  font-size: 10.5px;
  line-height: 16px;
  cursor: pointer;
}

.status-mcp:hover {
  background: var(--surface-2);
  border-color: var(--line-soft);
  color: var(--text-secondary);
}

.status-mcp:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.status-mcp.on {
  color: var(--text-secondary);
}

.mcp-led {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--faint);
}

.mcp-led.on {
  background: var(--green);
  box-shadow: 0 0 6px color-mix(in srgb, var(--green) 70%, transparent);
}

.mcp-port {
  color: var(--faint);
}

.status-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  overflow: hidden;
}

@media (max-width: 1180px) {
  /* Below this width the browser still needs room for two panes, so the dock
     gives up its fixed width first. */
  .app-body {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
}

@media (max-width: 900px) {
  .app-body {
    grid-template-columns: auto minmax(0, 1fr);
  }
}
</style>
