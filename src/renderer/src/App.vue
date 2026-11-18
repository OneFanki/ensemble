<script setup lang="ts">
import type { IdentityDraft, LoginCaptureNotice, Site, SiteDraft } from "@shared/types";
import type { UpdateCheckResult } from "@shared/update";
import { ChevronLeft } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import BrowserPage from "./components/BrowserPage.vue";
import GuestPool from "./components/GuestPool.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import HttpAuthDialog from "./components/HttpAuthDialog.vue";
import type { HttpAuthChallenge } from "@shared/ipc";
import FlowsPage from "./components/FlowsPage.vue";
import IdentitiesPage from "./components/IdentitiesPage.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import LoginCaptureBar from "./components/LoginCaptureBar.vue";
import Logo from "./components/Logo.vue";
import SessionHealthDialog from "./components/SessionHealthDialog.vue";
import SettingsPage, { type SettingsSection } from "./components/SettingsPage.vue";
import SiteDialog from "./components/SiteDialog.vue";
import SitesPage from "./components/SitesPage.vue";
import BookmarksPage from "./components/BookmarksPage.vue";
import MessagesPage from "./components/MessagesPage.vue";
import AiActivityPage from "./components/AiActivityPage.vue";
import ProfilesPage from "./components/ProfilesPage.vue";
import GuideDialog from "./components/GuideDialog.vue";
import TagsPage from "./components/TagsPage.vue";
import ToastStack from "./components/ToastStack.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import { type Locale, setLocale, tr } from "./i18n";
import { type LocaleSetting, resolveLocale } from "@shared/locale";
import { installWindowControlsWidth } from "./composables/windowControls";
import { GUIDE_VERSION, guideIsUnread } from "./onboarding/guide";
import { useConfirmStore } from "./stores/confirm";
import { useEmbeddedStore } from "./stores/embedded";
import { useNavigationStore } from "./stores/navigation";
import { useWorkspaceStore } from "./stores/workspace";

/**
 * Everything that can be on screen.
 *
 * The stage is single-cell (ADR 0012): the browser is the default page and the
 * management pages replace it in the same pane, reached from the instance
 * rail's [管理] menu. `settings` still covers the whole window with its own tab
 * bar, because it changes the workspace rather than showing part of it.
 *
 * `views` is gone from here (P1-3): the saved-view pages and dialogs are
 * retired from the UI; the workspace data keeps the `views` field for
 * compatibility, with no page to open.
 */
type View =
  | "browser"
  | "messages"
  | "ai"
  | "sites"
  | "identities"
  | "flows"
  | "tags"
  | "bookmarks"
  | "profiles"
  | "settings";

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const navigation = useNavigationStore();
const view = ref<View>("browser");
/**
 * Whether the opening splash is still covering the shell.
 *
 * `store.loading` alone was not enough: it clears inside `init()` before the
 * embedded state and the first stage measurement have landed, so the window
 * showed one frame of a half-built new tab. The splash stays until both stores
 * are ready and the shell has painted behind it, which also keeps the first
 * frame from being the boot row pushing the browser into the lower half.
 */
const bootReady = ref(false);
const bootStartedAt = performance.now();
/** A workspace that never answers must not leave the window on the splash. */
const bootWatchdog = window.setTimeout(() => {
  bootReady.value = true;
}, 8_000);
/**
 * The stage is single-cell and there is no sidebar: the browser fills the pane,
 * and a management page replaces it in the same pane when one is chosen.
 */
const siteDraft = ref<SiteDraft | null>(null);
const identityDraft = ref<IdentityDraft | null>(null);
/** The in-app guide: the only first-run introduction and the readable handbook. */
const guideOpen = ref(false);
const healthOpen = ref(false);
/**
 * Whether the "save this login?" bar is on screen.
 *
 * Separate from "is there a pending capture": hiding the bar must not throw the
 * capture away. It comes back on its own when another login is captured, and the
 * toolbar's bell opens the same list at any time.
 */
const captureVisible = ref(true);
watch(
  () => store.pendingLogins.length,
  (count, previous) => {
    // A new capture always earns the prompt back, even after one was hidden.
    if (count > 0 && count >= previous) captureVisible.value = true;
    // An explicit hide must not survive the list emptying and refilling: the
    // prompt is about the newest capture, and dismissing a whole batch is not a
    // standing preference to be told about the next one.
    else if (count === 0) captureVisible.value = true;
  },
);
/** True while an HTML overlay covers the browser stage. */
const stageObscured = ref(false);
/** Set by a background check, or by the manual check in Settings. */
const updatePrompt = ref<UpdateCheckResult | null>(null);
/** The HTTP authentication challenge awaiting the user, if any. */
const authChallenge = ref<HttpAuthChallenge | null>(null);

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
        healthOpen.value ||
        updatePrompt.value ||
        guideOpen.value,
    ),
);

/**
 * Whether the prompt has to give up the screen to something else.
 *
 * Dialogs do, for two reasons that happen to share one fix:
 *
 * 1. A modal locks `body { pointer-events: none }` (reka-ui does this), and the
 *    prompt is a fixed child of the body, outside the dialog's portal. It stayed
 *    visible over the mask but swallowed every press — it looked stuck, and the
 *    only way out was closing the dialog underneath it.
 * 2. It is not needed inside the account form anyway: that form *is* the answer
 *    to the prompt.
 *
 * The guide is deliberately NOT in this list. It opens by itself on a first run
 * and stays until dismissed; letting it suppress the prompt meant a new user's
 * very first login was captured, prompted, and then invisible underneath the
 * introduction. The prompt is small and sits at the bottom edge, so sharing the
 * screen with the guide costs nothing.
 */
const captureCovered = computed(
  () =>
    stageObscured.value ||
    Boolean(
      confirm.current ||
        siteDraft.value ||
        identityDraft.value ||
        healthOpen.value ||
        updatePrompt.value,
    ),
);

/** The prompt, when it is both wanted and not covered by a dialog. */
const capturePromptVisible = computed(
  () => captureVisible.value && store.pendingLogins.length > 0 && !captureCovered.value,
);

/**
 * Holds the splash for a moment, then reveals the painted shell.
 *
 * The minimum is not a spinner pretending work is still happening: it keeps a
 * fast start from flashing a logo for two frames, and gives the first paint of
 * the shell something to land behind. Fonts are awaited for the same reason —
 * revealing before they settle moves every label a frame after the user starts
 * reading it.
 */
async function finishBoot(): Promise<void> {
  await document.fonts.ready.catch(() => undefined);
  const remaining = 500 - (performance.now() - bootStartedAt);
  if (remaining > 0) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  window.clearTimeout(bootWatchdog);
  bootReady.value = true;
}

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
  setLocale(resolvedLocale.value);
  const saved = store.settings.lastView;
  // The browser is the default page; returning to where the user left off beats
  // resetting them to a management page they only visited once. Bookmarks and
  // profiles are never restored for the same reason settings is not: they are
  // places you go to change something, not where work sits. A saved "views"
  // (the retired page) falls through to the browser like any unknown value.
  view.value =
    saved === "sites" ||
    saved === "identities" ||
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
  // A server demanded HTTP credentials; the main process shows one dialog per
  // protection space, so this arrives only when the user must actually type.
  window.ensemble.onHttpAuthChallenge((challenge) => {
    authChallenge.value = challenge;
  });
  // Cmd+, arrives from the native menu; the renderer never binds the key itself.
  // Defaulting the section keeps "wherever I was" for this entry: the user asked
  // for settings, not for a particular pane.
  window.ensemble.onOpenSettings(() => openSettings(settingsSection.value));

  await finishBoot();
  /*
   * First run: the guide opens by itself, once.
   *
   * It used to be a spotlight tour that pointed at live controls, and that was
   * the wrong shape here twice over: the UI it pointed at kept moving, and a
   * series of callouts teaches where a button is without ever saying what the
   * product is for. The guide answers both in one page, and it is the same page
   * the title-bar dot and the Settings entry open later — so there is exactly
   * one introduction to keep current.
   *
   * Scheduled after the splash: opening it underneath would make the first
   * visible frame the guide's backdrop instead of the shell.
   */
  if (guideIsUnread(store.settings)) {
    window.setTimeout(() => {
      void openGuide();
    }, 350);
  }
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
onUnmounted(() => {
  systemTheme.removeEventListener("change", handleSystemThemeChange);
});

function switchView(next: View) {
  view.value = next;
  // "settings", "bookmarks" and "profiles" are deliberately not persisted as the
  // view to restore: settings is a place you go to change something, and the
  // other two are management pages whose content is also reachable from the
  // browser. Restoring any of them on launch would look like the app opened on
  // the wrong screen.
  if (next !== "settings" && next !== "bookmarks" && next !== "profiles") {
    void store.saveSettings({ lastView: next });
  }
}

/**
 * The browser toolbar's way into the management pages.
 *
 * The menu names a destination; without one it lands on Settings, because the
 * menu's other rows are already there to be clicked instead.
 */
function openConsole(
  target: "sites" | "bookmarks" | "profiles" | "settings" | "messages" | "ai" = "settings",
) {
  if (target === "settings") {
    openSettings("general");
    return;
  }
  switchView(target);
}

/**
 * Opens Settings at a named section.
 *
 * Settings covers the window, so it is a view of its own rather than a series of
 * sidebar rows. The section travels as a request (with a counter) rather than as
 * a prop the page mirrors: the page stays mounted, and coming back to the same
 * section after the user picked another one has to count as a new request.
 */
function openSettings(section: SettingsSection = "general") {
  settingsSection.value = section;
  settingsSectionSeq.value += 1;
  switchView("settings");
}

/**
 * The instance rail's [管理] menu: the way into the management pages.
 *
 * TODO(第二波·管理窗格): these pages collapse into a dedicated pane; the button
 * stays, only what it opens changes. Settings keeps its own full-window shell.
 */
function manageTo(target: string): void {
  if (target === "settings") {
    openSettings("general");
    return;
  }
  switchView(target as View);
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
  [view, bootReady],
  ([next, ready]) => embedded.suspendStage(!ready || next !== "browser"),
  { flush: "sync", immediate: true },
);

/**
 * Which settings tab is on screen.
 *
 * State rather than a prop the page owns, because three callers outside the page
 * pick a section — the AI entry, the update prompt, and the native menu — and two
 * of them mean "that specific tab" while the third means "wherever I was".
 */
const settingsSection = ref<SettingsSection>("general");
/** Bumped per request; a repeated request for the same tab still has to land. */
const settingsSectionSeq = ref(0);

/** Status-bar shortcut into Settings → AI access. */
function openMcpSettings() {
  openSettings("mcp");
}

// The toolbar's AI entry lives three components down; this is how it reaches
// Settings without every layer in between having to forward a handler.
navigation.bind((next, tab) => {
  if (next === "settings") {
    openSettings((tab as SettingsSection | undefined) ?? settingsSection.value);
    return;
  }
  switchView(next as View);
});

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

/*
 * 视图（saved view）的创建/编辑/删除入口已随 P1-3 从 UI 退役：批量启动由
 * InstanceRail 的 [+ 启动] 多选承接，不再经「保存一组」的表单。workspace 数据
 * 里的 `views` 字段与其读写（store.saveView / deleteView / core 层）原样保留，
 * 做兼容性 round-trip，只是不再有页面打开它们。
 */

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
  if (!result) return;
  identityDraft.value = null;
  /*
   * The captured password is consumed on save, so the prompt goes with it.
   * Named by token: a second capture waiting behind this one must survive.
   *
   * Nothing else happens here on purpose. This used to launch the account as
   * well — "prove the password was stored, the page comes up signed in" — but
   * being right about the password is not a reason to open a browser. Someone
   * who clicked "save account" asked for the account to be stored; a window
   * appearing on its own reads as the app doing something they did not ask for.
   * The toast already confirms the save, and launching stays one click away.
   */
  if (draft.captureToken) store.clearLoginCapture(draft.captureToken);
}

/**
 * Opens the account form pre-filled from a captured login.
 *
 * The site is matched by origin when one exists; otherwise the form opens with
 * an inline "create this site" suggestion already filled, so the user does not
 * have to leave and come back.
 */
/**
 * Opens the account form pre-filled from a login seen in the daily profile.
 *
 * The whole point of this path is that nobody had to fill in a site first: a
 * bookmark, a typed address and a login are enough to end up with a real account.
 * So when no site matches the origin, one is created here rather than asking the
 * user to describe a site they just used — its name comes from the host, and its
 * login path is the page the form was on. Everything else stays at its default
 * and can be refined later from the site's own dialog.
 *
 * The account itself is a full identity: saving it gives the login its own
 * profile, which is what makes the next launch isolated from the daily profile
 * the password was first typed into.
 */
async function saveCapturedLogin(notice: LoginCaptureNotice): Promise<void> {
  let site = notice.siteId ? store.sites.find((item) => item.id === notice.siteId) : undefined;
  if (!site) {
    site = await createSiteFromCapture(notice);
    if (!site) return;
  }
  const origin = site.id;
  const existing = store.identities.find(
    (identity) =>
      identity.username.toLowerCase() === notice.username.toLowerCase() &&
      identity.siteId === origin,
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
      extraFields: [
        ...(existing.extraFields ? existing.extraFields.map((field) => ({ ...field })) : []),
        // A tenant the capture saw but the saved account does not carry yet:
        // this is a different account on the same site, not the same one.
        ...(notice.extraFields ?? [])
          .filter(
            (field) =>
              field.value.trim() &&
              !(existing.extraFields ?? []).some(
                (have) => have.label.trim().toLowerCase() === field.label.trim().toLowerCase(),
              ),
          )
          .map((field) => ({ ...field })),
      ],
      tagIds: existing.tagIds ? [...existing.tagIds] : [],
      note: existing.note,
      captureToken: notice.token,
    };
    return;
  }
  identityDraft.value = {
    siteId: site.id,
    name: notice.username,
    username: notice.username,
    role: "member",
    color: "teal",
    passwordMode: "custom",
    startPath: notice.path || "/",
    // Pre-filled so a multi-tenant site keeps its tenant: it is part of which
    // account this is, and the login that just happened typed it.
    extraFields: (notice.extraFields ?? []).map((field) => ({ ...field })),
    tagIds: [],
    captureToken: notice.token,
  };
}

/**
 * Creates the site a captured login belongs to.
 *
 * Returning undefined means the site could not be written (the workspace store
 * has already reported why); the capture stays pending in the main process so a
 * retry is possible rather than silently dropping the password.
 */
async function createSiteFromCapture(
  notice: LoginCaptureNotice,
): Promise<Site | undefined> {
  let host: string;
  try {
    host = new URL(notice.origin).hostname;
  } catch {
    host = notice.origin;
  }
  const result = await store.saveSite({
    name: host,
    baseUrl: notice.origin,
    loginPath: notice.path || "/",
    // Omitted rather than empty: the schema rejects a present-but-blank check
    // field, and the site dialog has always dropped blanks for that reason. This
    // path went around the dialog and passed `""`, which failed validation and
    // made "save this login" the one save that never worked.
    autoSubmit: undefined,
    tagIds: [],
  });
  if (!result) return undefined;
  const saved = result.sites.find(
    (item) => item.name === host && item.baseUrl === notice.origin.replace(/\/$/, ""),
  );
  if (saved) store.markSiteUsed(saved.id);
  return saved;
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

async function deleteSite(siteId: string) {
  await store.deleteSite(siteId);
  siteDraft.value = null;
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
    <!-- Covers the shell until it has painted, instead of taking a flex row of
         its own and squeezing the browser into the lower half of the window. -->
    <Transition name="boot-fade">
      <div v-if="!bootReady" class="boot drag-region" aria-busy="true">
        <span class="boot-mark"><Logo :size="34" /></span>
        <span class="boot-copy">
          <span class="boot-name">Ensemble</span>
          <span class="boot-hint">{{ $t("app.bootHint") }}</span>
        </span>
      </div>
    </Transition>

    <!--
      One pane for everything except settings: the browser fills it, and a
      management page replaces it in the same pane. The stage is single-cell
      (ADR 0012) and the instance rail is the window's first row; [管理] at its
      right end is how the management pages are reached (TODO(第二波·管理窗格):
      they collapse into a dedicated pane, this list is the interim shape).

      Settings still covers the window with its own tab bar, because it changes
      the workspace rather than showing part of it.
    -->
    <SettingsPage
      v-if="view === 'settings'"
      :section="settingsSection"
      :section-seq="settingsSectionSeq"
      @back="switchView('browser')"
      @theme="handleTheme"
      @locale="handleLocale"
      @update-found="(result) => (updatePrompt = result)"
    />

    <main v-else class="pane" :class="{ 'pane-console': view !== 'browser' }">
      <!--
        The band the native window controls own, and the way back.

        Management pages are ordinary in-flow HTML with a 24px top padding, so
        their first row — the page title and its action buttons — landed right
        under the caption buttons drawn by the OS, and the right-hand button
        was clipped in half. This band reserves the caption area and is the
        draggable strip a frameless window needs; without it the whole page
        has no way to move the window at all.

        The back arrow is the page's way back to the browser: with the
        navigation column gone, this band is where the way back lives. It is
        the same door the browser's instance rail opens in the other direction.
      -->
      <div v-if="view !== 'browser'" class="pane-band drag-region" :data-platform="platform">
        <button
          type="button"
          class="pane-back no-drag"
          :aria-label="tr('app.backToBrowser')"
          v-tooltip="tr('app.backToBrowser')"
          data-nav="browser"
          @click="switchView('browser')"
        >
          <ChevronLeft :size="14" />
        </button>
      </div>
      <BrowserPage
        v-if="view === 'browser'"
        :obscured="overlayOpen"
        @open-console="openConsole"
        @manage="manageTo"
        @open-guide="openGuide"
        @update-found="(result) => (updatePrompt = result)"
        @save-capture="saveCapturedLogin"
      />
      <SitesPage
        v-else-if="view === 'sites'"
        @new-site="openNewSite"
        @edit-site="openEditSite"
        @open-site="openSite"
        @add-identity="openNewIdentity"
      />
      <IdentitiesPage
        v-else-if="view === 'identities'"
        @new-identity="openNewIdentity"
        @edit-identity="openEditIdentity"
        @session-health="healthOpen = true"
      />
      <FlowsPage v-else-if="view === 'flows'" />
      <TagsPage v-else-if="view === 'tags'" />
      <MessagesPage v-else-if="view === 'messages'" @save-capture="saveCapturedLogin" />
      <AiActivityPage v-else-if="view === 'ai'" />
      <ProfilesPage v-else-if="view === 'profiles'" />
      <BookmarksPage v-else />
    </main>

    <!-- A login seen in an embedded page. Floating above the dock so it never
         covers the page the user is still working in, and never takes a row in
         the app grid — it is a prompt, not part of the layout. Closing it
         collapses it to a count chip in the same place, not out of existence:
         the capture is still waiting, and the chip is how you get back to it.

         It yields to a dialog, though: a modal locks `body` pointer events and
         the bar lives outside the dialog's portal, so it used to stay visible
         over the mask and swallow every click. `data-capture-probe` states which
         of the three inputs blocked it, so a failing e2e says which one. -->
    <div
      class="sr-only"
      data-capture-probe
      :data-list="store.pendingLogins.length"
      :data-shown="captureVisible ? '1' : '0'"
      :data-covered="captureCovered ? '1' : '0'"
      :data-what="[
        stageObscured ? 'stage' : '',
        confirm.current ? 'confirm' : '',
        siteDraft ? 'site' : '',
        identityDraft ? 'identity' : '',
        healthOpen ? 'health' : '',
        updatePrompt ? 'update' : '',
        guideOpen ? 'guide' : '',
      ]
        .filter(Boolean)
        .join('+')"
    ></div>
    <div v-if="capturePromptVisible" class="capture-wrap">
      <LoginCaptureBar
        :notices="store.pendingLogins"
        :site-name-of="(notice) => store.sites.find((s) => s.id === notice.siteId)?.name"
        :profile-note="tr('app.loginCaptureProfileNote')"
        @save="saveCapturedLogin"
        @dismiss="store.dismissLoginCapture"
        @hide="captureVisible = false"
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
      :password-set="identityDraft.id ? store.identityPasswordSet(store.identities.find(i => i.id === identityDraft!.id)!) : false"
      @save="saveIdentity"
      @close="identityDraft = null"
      @create-site="createSiteFromIdentity"
      @delete="store.deleteIdentity(identityDraft!.id!); identityDraft = null"
    />

    <SessionHealthDialog v-if="healthOpen" @close="healthOpen = false" />

    <HttpAuthDialog :challenge="authChallenge" @close="authChallenge = null" />

    <UpdateDialog
      v-if="updatePrompt"
      :result="updatePrompt"
      @dismissed="(version) => store.saveSettings({ dismissedUpdateVersion: version })"
      @close="updatePrompt = null"
    />

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
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--content);
}

/*
 * The opening splash is an overlay, never a row.
 *
 * It used to be a flex child beside the shell, so during initialization the
 * window was split: the logo in the top half and a half-height new tab in the
 * bottom half. Making it absolute both removes that frame and gives the shell
 * the whole window to lay itself out behind the logo.
 */
.boot {
  position: absolute;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  /*
   * A fixed dark brand surface, not the theme's content colour. The theme is
   * only known after the workspace snapshot arrives, so a themed splash would
   * flip colour mid-boot on a light-theme machine; a dark opening that fades to
   * either theme reads as intentional.
   */
  background: #101317;
  color: #8b949e;
  --logo-back: #c9d1d9;
  --logo-mid: #8a939e;
  --logo-card: #e0a44e;
  --logo-glyph: #1a1206;
  font-size: var(--fs-base);
}

.boot-mark {
  display: flex;
  animation: boot-breathe 1.6s ease-in-out infinite;
}

@keyframes boot-breathe {
  0%,
  100% {
    opacity: 0.65;
    transform: scale(0.96);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.boot-fade-leave-active {
  transition: opacity 180ms ease;
  pointer-events: none;
  -webkit-app-region: no-drag;
}

.boot-fade-leave-to {
  opacity: 0;
}

.boot-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.boot-name {
  font-size: var(--fs-md);
  font-weight: 500;
  color: #e6e8eb;
}

.boot-hint {
  font-size: var(--fs-2xs);
  color: #8b949e;
}

/*
 * The content pane: the browser page, or a management page in its place.
 *
 * There is no sidebar: the pane is the window, and the instance rail — the
 * browser page's own first row — is where navigation lives. A management page
 * is not a different screen, it is this pane showing something else.
 *
 * No background and no stacking of its own while the browser shows: pages are
 * real compositing surfaces stacked at `z-index: 1` at the app root, so a pane
 * that painted a background would cover the very page it is framing. The
 * management pages get their own covering surface below, only while one of
 * them is showing.
 */
.pane {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/*
 * A management page, holding the pane.
 *
 * This is where the covering surface belongs: the page has to paint over the
 * parked guests, and it is the one case where an opaque layer is correct. Above
 * the pool by number rather than by arrival order — parking the guests when the
 * view changes is a timing bet, and the guest layer can still be composited for
 * a frame after its element has moved, which showed up as the two swapping
 * places twice on the way in.
 */
.pane-console {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--content);
  position: relative;
  z-index: 2;
  overflow: hidden;
}

/*
 * The caption band above a management page.
 *
 * Same height as the browser's tab strip, so switching between the browser and a
 * management page does not move the window's own buttons or the page's first row.
 * The right padding is what keeps page-head-actions out from under the caption
 * buttons.
 */
.pane-band {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  height: var(--titlebar-height);
  /* Windows/Linux reserve the right corner for the caption buttons. */
  padding-right: var(--window-controls-width, 138px);
}

/* The band inherits the pane's background so it reads as part of the page frame
   rather than as a second toolbar. */
.pane-console > .pane-band {
  background: var(--frame);
}

/* The way back to the browser, at the band's leading edge. */
.pane-back {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-left: 6px;
  border-radius: var(--radius);
  color: var(--muted);
}

.pane-back:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
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
