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
import GuestPool from "./components/GuestPool.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import ConsoleHeader from "./components/ConsoleHeader.vue";
import ConsoleSidebar from "./components/ConsoleSidebar.vue";
import FlowsPage from "./components/FlowsPage.vue";
import IdentitiesPage from "./components/IdentitiesPage.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import LoginCaptureBar from "./components/LoginCaptureBar.vue";
import Logo from "./components/Logo.vue";
import RunDock from "./components/RunDock.vue";
import SessionHealthDialog from "./components/SessionHealthDialog.vue";
import SettingsPage from "./components/SettingsPage.vue";
import SiteDialog from "./components/SiteDialog.vue";
import SitesPage from "./components/SitesPage.vue";
import SpotlightTour from "./components/SpotlightTour.vue";
import BookmarksPage from "./components/BookmarksPage.vue";
import GuideDialog from "./components/GuideDialog.vue";
import TagsPage from "./components/TagsPage.vue";
import ToastStack from "./components/ToastStack.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import ViewDialog from "./components/ViewDialog.vue";
import ViewsPage from "./components/ViewsPage.vue";
import { type Locale, setLocale, tr } from "./i18n";
import { type LocaleSetting, resolveLocale } from "@shared/locale";
import { installWindowControlsWidth } from "./composables/windowControls";
import { GUIDE_VERSION, guideIsUnread } from "./onboarding/guide";
import {
  shouldAutoStartTour,
  TOUR_STEPS,
  TOUR_VERSION,
  type TourView,
} from "./onboarding/tourSteps";
import { useConfirmStore } from "./stores/confirm";
import { useEmbeddedStore } from "./stores/embedded";
import { useNavigationStore } from "./stores/navigation";
import { useWorkspaceStore } from "./stores/workspace";

type View =
  | "browser"
  | "sites"
  | "identities"
  | "views"
  | "flows"
  | "tags"
  | "bookmarks"
  | "settings";

/**
 * Which of the two shells is on screen.
 *
 * 1.0 had one shell: a side rail, a stage, and a run dock, all permanent. That
 * made every screen an admin console — the browser was one page among eight and
 * the tools took the edges of the window even while someone was just reading a
 * page. The model did not change; only its expression did. "Browse" is a
 * browser, and a browser is exactly a 1x1 layout with one instance in it.
 *
 * Browse: tab strip, toolbar, page. No rail, no dock.
 * Bench: the same chrome, plus the run dock and the cells of a multi-cell layout.
 *
 * The mode follows the layout unless the user pins it: entering a multi-cell
 * layout is the act of asking for a workbench, and collapsing back to one cell
 * is the act of leaving it. Persisted so a restart lands where the work was.
 */
type ShellMode = "browse" | "bench";

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const navigation = useNavigationStore();
const view = ref<View>("browser");
const mode = ref<ShellMode>(store.settings.shellMode ?? "browse");
/** True while the management console covers the browser. */
const consoleOpen = computed(() => view.value !== "browser");
const siteDraft = ref<SiteDraft | null>(null);
const identityDraft = ref<IdentityDraft | null>(null);
const viewDraft = ref<ViewDraft | null>(null);
const layoutEditor = ref<{ preset?: LayoutPreset; seed?: SlotRect[]; viewId?: string } | null>(
  null,
);
const tourOpen = ref(false);
/** The in-app guide: a page of its own, not the spotlight tour. */
const guideOpen = ref(false);
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
 * Whether the first-run tour starts by itself.
 *
 * Off during the 2.0 shell work: the tour points at live controls, and the
 * controls are moving. It is a single flag rather than a deletion so the tour can
 * come back without rebuilding it — the steps, the version bookkeeping and the
 * Settings replay entry all stay in place.
 */
const AUTO_TOUR_ENABLED = false;

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
        tourOpen.value ||
        guideOpen.value,
    ),
);

onMounted(async () => {
  await store.init();
  await embedded.init();
  // Measured from the native overlay rather than guessed: every surface that
  // reaches the window's top-right corner reserves this band, and a hardcoded
  // number is what put the dock's own header underneath the caption buttons.
  installWindowControlsWidth(store.snapshot?.platform ?? "win32");
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
  /*
   * The first-run tour is deliberately off while 2.0 is in progress.
   *
   * The tour points at live controls, and the shell it was written against is
   * being replaced — a spotlight on a moved button is worse than nothing. The
   * code paths and the stored version stay untouched so the tour can be turned
   * back on with this one flag once the interface settles, and the Settings entry
   * that replays it still works for anyone who asks for it.
   */
  if (AUTO_TOUR_ENABLED && shouldAutoStartTour(store.settings)) {
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
  // Cmd+, arrives from the native menu; the renderer never binds the key itself.
  window.ensemble.onOpenSettings(() => openSettings());
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
  // "settings" and "bookmarks" are deliberately not persisted as the view to
  // restore: settings is a place you go to change something, and bookmarks is a
  // management page whose content is also on the start page. Restoring either on
  // launch would look like the app opened on the wrong screen.
  if (next !== "settings" && next !== "bookmarks") {
    void store.saveSettings({ lastView: next });
  }
}

/**
 * The browser's one door into the console.
 *
 * It lands on Settings, not on Sites. The control is a gear (see
 * `BrowserPage.vue`), and a gear that opens a table of sites is a promise the
 * shape does not keep: the thing people reach for when they see a gear is the
 * place where preferences live. Everything else in the console is one click away
 * from its rail.
 */
function openConsole() {
  switchView("settings");
}

/**
 * Hands the window over to, or back from, the console.
 *
 * A watcher on the view rather than a line in `switchView`, because `switchView`
 * is not the only way in: the native menu, the status bar and the guide all set
 * the view directly, and every one of them opens a panel over a live page. This
 * is synchronous on purpose — the console is in-flow HTML while a page is a real
 * native surface, so the pages have to be parked in the same task that decides to
 * draw the console, or the first frame of the console renders underneath the page
 * it replaced.
 */
watch(
  view,
  (next) => embedded.suspendStage(next !== "browser"),
  { flush: "sync", immediate: true },
);

/**
 * The shell follows the layout.
 *
 * Only ever widens automatically: a multi-cell layout is the user asking for a
 * workbench, so the dock appears. Narrowing back is left to the user — closing
 * the last extra cell while the dock is open should not yank a panel away from
 * under the pointer mid-task.
 */
watch(
  () => {
    const active = embedded.activeView;
    return active ? embedded.slots(active) : 1;
  },
  (count) => {
    if (count > 1 && mode.value !== "bench") setMode("bench");
  },
);

function setMode(next: ShellMode): void {
  if (mode.value === next) return;
  mode.value = next;
  void store.saveSettings({ shellMode: next });
  if (next === "bench") void enterBenchLayout();
}

/**
 * Give the focused view a multi-cell layout.
 *
 * The dock exists to show what is running across cells, so opening the workbench
 * with a 1x1 layout would be a column of tool chrome beside a page with nothing
 * to arrange. 2x1 is the smallest honest grid; the layout picker is right there
 * for anything else.
 */
async function enterBenchLayout(): Promise<void> {
  const active = embedded.activeView;
  if (!active) return;
  const slots = embedded.slots(active);
  if (slots > 1) return;
  await window.ensemble.setEmbeddedViewSlots(active.id, [
    { x: 0, y: 0, width: 0.5, height: 1 },
    { x: 0.5, y: 0, width: 0.5, height: 1 },
  ]);
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

// The toolbar's AI entry lives three components down; this is how it reaches
// Settings without every layer in between having to forward a handler.
navigation.bind((next, tab) => {
  if (tab) {
    settingsTab.value = tab as typeof settingsTab.value;
    settingsTabSeq.value += 1;
  }
  switchView(next as View);
});
/**
 * Settings page from the native menu (Cmd+, on macOS).
 *
 * Unlike `openMcpSettings` this does not retarget the tab: the user asked for
 * "settings", not for a particular pane, so whatever they opened last is what
 * they expect to see.
 */
function openSettings() {
  view.value = "settings";
}
function startTour() {
  tourSession.value += 1;
  tourOpen.value = true;
}

async function finishTour(completed: boolean): Promise<void> {
  tourOpen.value = false;
  // Both endings land on the browser page, whoever started the tour and
  // wherever it stopped.
  //
  // The reason is the empty views page: the step before the last one is "create
  // a view", so a tour that ended there — or a user who pressed skip while on
  // it — left a newcomer staring at a page of nothing and reading it as "I must
  // create a view before anything can happen". The browser page is where the
  // work starts, and it is also where the run dock the last step explained is
  // visible. Replaying the tour from Settings therefore also ends here rather
  // than dropping the user back into Settings.
  view.value = "browser";
  if ((store.settings.onboardingVersion ?? 0) < TOUR_VERSION) {
    await store.saveSettings({ onboardingVersion: TOUR_VERSION });
  }
  // A finished tour hands over to the guide; a skipped one does not.
  //
  // The tour shows a newcomer where things are, one control at a time, and ends
  // without ever stating the point: three steps, and the AI can do all of them.
  // Someone who clicked through it (or read it) gets that summary immediately,
  // which is the one moment they are paying attention. Someone who pressed skip
  // asked not to be walked through anything, so nothing is pushed at them — the
  // unread dot on the title bar stays there instead.
  if (completed && guideIsUnread(store.settings)) {
    await openGuide();
  }
}

function handleTourNavigate(next: TourView) {
  view.value = next;
}

/**
 * Opens the guide and marks it read.
 *
 * Marking on open rather than on close: a dot that survives a visit because the
 * user clicked away mid-read is worse than one that disappears a little early.
 * The guide is short enough that opening it is reading it.
 */
async function openGuide(): Promise<void> {
  guideOpen.value = true;
  if (guideIsUnread(store.settings)) {
    await store.saveSettings({ guideVersion: GUIDE_VERSION });
  }
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
    authTokenKey: env.authTokenKey ?? "",
    authTokenHeader: env.authTokenHeader ?? "",
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
    <!--
      Page nodes live here, at the root, not inside the browser page: a node
      removed from the document destroys its renderer process, and the browser
      page unmounts whenever the console is open — while AI tools keep using
      tabs from there.
    -->
    <GuestPool />
    <div v-if="store.loading" class="boot">
      <Logo :size="30" />
      <span class="boot-copy">
        <span class="boot-name">Ensemble</span>
        <span class="boot-hint">{{ $t("app.bootHint") }}</span>
      </span>
    </div>

    <!--
      The browser, and only the browser.

      There is no rail and no dock here: a browser is a tab strip, a toolbar and
      a page. Everything management-shaped lives in the console, which covers
      this surface when opened. A single-cell layout with one instance *is* a
      browser, so this mode needs no special case.
    -->
    <div v-else-if="!consoleOpen" class="workspace">
      <BrowserPage
        :obscured="overlayOpen"
        :bench="mode === 'bench'"
        @open-console="openConsole"
        @switch-mode="setMode"
      />

      <!--
        The run dock appears only when a multi-cell layout is on stage. In a
        1x1 layout it would be a column of tool chrome beside a page — which is
        the admin-console look this shell exists to leave behind.
      -->
      <RunDock v-if="mode === 'bench'" class="shell-dock" />
    </div>

    <!--
      The management console: a full-window destination, the way browser
      settings are. The tabs it offers are the 1.0 navigation, unchanged — the
      pages themselves did not need rewriting, only a home of their own.
    -->
    <div v-else class="console">
      <ConsoleHeader @back="switchView('browser')" />
      <!--
        Title bar across the full width, then a rail and the page side by side.
        The rail is the console's navigation; putting it in the same row as the
        content is what lets the title bar stay a drag band shared with the
        browser shell.
      -->
      <div class="console-body">
        <ConsoleSidebar :view="view" @navigate="switchView" />
        <main class="console-pane">
        <SitesPage
          v-if="view === 'sites'"
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
        <BookmarksPage v-else-if="view === 'bookmarks'" />
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
      </div>
    </div>

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

    <!-- Above the tour in the tree, below it in z-order only when both are open,
         which cannot happen: the guide is opened from the title bar or the tour's
         last step, never while the tour is still running. -->
    <GuideDialog v-if="guideOpen" @close="guideOpen = false" />
  </div>
</template>

<style scoped>
/*
 * Two rows, not three.
 *
 * 1.0 reserved a 30px status bar and drew a decorative radial gradient across
 * the whole shell. A browser has neither: the chrome is flat, and the only
 * status the user needs sits on the controls that own it (AI state on the AI
 * button, instance count in the dock header, version in the console).
 */
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--content);
}

.boot {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: var(--fs-base);
}

.boot-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.boot-name {
  font-size: var(--fs-md);
  font-weight: 500;
  color: var(--text);
}

.boot-hint {
  font-size: var(--fs-2xs);
  color: var(--faint);
}

/*
 * The browser and its dock, side by side.
 *
 * A row container rather than two children of the shell: the shell is a column,
 * and putting the dock directly in it stacked the dock *under* the page instead
 * of beside it — which also left the stage measuring the full window width while
 * a dock column sat over nothing.
 */
.workspace {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  align-items: stretch;
}

/*
 * The run dock rides beside the stage, and only while a multi-cell layout is on
 * stage. It is a sibling of the browser rather than a child because the browser
 * measures its own stage from its own box: nesting the dock inside would make
 * that measurement depend on the dock's existence.
 */
.shell-dock {
  flex: 0 0 auto;
  min-width: 0;
}

.console {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--content);
  /*
   * Above the page pool, by number rather than by arrival order.
   *
   * Every page is a real compositing surface stacked at `z-index: 1` at the app
   * root. Parking them when this view opens is a timing bet: the guest layer can
   * still be composited for a frame after its element has been moved, which
   * showed up as the page and the settings panel swapping places twice on the
   * way in. Claiming a higher layer here means no ordering mistake upstream can
   * ever put a page in front of the console.
   */
  position: relative;
  z-index: 2;
}

/* Rail and page share the row under the title bar. */
.console-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  min-width: 0;
}

.console-pane {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
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
  z-index: var(--z-toast);
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  width: min(520px, calc(100vw - 48px));
  /* Rises from the bottom edge, which is where it lives. The resting transform
     keeps the horizontal centring, so both keyframes have to state it. */
  animation: capture-in var(--motion-slow) var(--ease-out);
}

@keyframes capture-in {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
</style>
