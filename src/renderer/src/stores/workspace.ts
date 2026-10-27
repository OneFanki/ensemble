import type { EnsembleApi } from "@shared/ipc";
import type { Flow, FlowDraft } from "@shared/flows";
import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID, findLayout, isFreeLayout } from "@shared/layouts";
import {
  DEFAULT_SEARCH_ENGINE_ID,
  SEARCH_ENGINES,
  type SearchEngine,
} from "@shared/search";
import { DEFAULT_NEW_TAB_BACKDROP, newTabBackdrop } from "@shared/newtab";
import type {
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  Bookmark,
  BookmarkDraft,
  Engine,
  Identity,
  IdentityDraft,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  LoginCaptureNotice,
  McpPatch,
  McpStatus,
  PasswordOwner,
  ReloginBatchResult,
  SettingsPatch,
  Site,
  SiteDraft,
  TagDraft,
  View,
  ViewDraft,
  WorkspaceSnapshot,
} from "@shared/types";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { tr } from "../i18n";
import { useConfirmStore } from "./confirm";

declare global {
  interface Window {
    ensemble: EnsembleApi;
  }
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: "info" | "error" | "success" | "warning";
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const snapshot = ref<WorkspaceSnapshot | null>(null);
  const loading = ref(true);
  const busy = ref<string | null>(null);
  const toasts = ref<ToastMessage[]>([]);
  /**
   * The most recent login seen in an embedded page.
   *
   * One at a time on purpose: this is a "sort it out now" prompt, and a stack of
   * them would sit over the page the user is still working in.
   */
  const loginCapture = ref<LoginCaptureNotice | null>(null);
  /** Most recently used site; only a default for new drafts, not a global scope. */
  const recentSiteId = ref<string | null>(null);
  /**
   * The MCP endpoint as the main process reports it.
   *
   * Shared rather than owned by the settings page: the status bar shows the same
   * state on every screen, and a second copy would go stale the moment settings
   * changed the port or switched the endpoint off.
   */
  const mcp = ref<McpStatus | null>(null);
  /** AI page actions this session, keyed by origin. */
  const aiActions = ref<Record<string, number>>({});
  /** Origin of the most recent AI action, so the dock can pulse the right row. */
  const lastAiOrigin = ref<string | null>(null);
  let toastSeq = 0;

  const api = computed(() => window.ensemble);
  const confirm = useConfirmStore();

  function apply(next: WorkspaceSnapshot) {
    snapshot.value = next;
    if (!recentSiteId.value || !next.sites.some((site) => site.id === recentSiteId.value)) {
      recentSiteId.value = next.settings.lastSiteId ?? next.sites[0]?.id ?? null;
    }
  }

  async function init() {
    loading.value = true;
    try {
      apply(await window.ensemble.getWorkspace());
      window.ensemble.onWorkspaceChanged((next) => apply(next));
      window.ensemble.onAutoFilled((report) => announceAutoFill(report));
      window.ensemble.onLoginCaptured((notice) => {
        loginCapture.value = notice;
      });
      window.ensemble.onMcpChanged((status) => {
        mcp.value = status;
      });
      window.ensemble.onAiPageAction((event) => {
        // Per-origin totals for this session; the dock shows them beside the
        // account, so "the AI is working in this site" is answerable at a glance
        // instead of by reading the audit log.
        aiActions.value = { ...aiActions.value, [event.origin]: event.count };
        lastAiOrigin.value = event.origin;
      });
    } finally {
      loading.value = false;
    }
  }

  /** Forgets a capture without saving it; the secret is dropped in the main process. */
  async function dismissLoginCapture(notice: LoginCaptureNotice): Promise<void> {
    if (loginCapture.value?.token === notice.token) loginCapture.value = null;
    await window.ensemble.dismissLoginCapture(notice.token);
  }

  function clearLoginCapture(): void {
    loginCapture.value = null;
  }

  function announceAutoFill(report: AutoFillReport) {
    if (report.skipped === "cross-origin") {
      notify(tr("app.toastCrossOrigin", { name: report.label }), "error");
      return;
    }
    if (report.skipped === "origin-changed") {
      void confirmChangedOrigin(report);
      return;
    }
    if (report.skipped === "login-failed") {
      notify(tr("app.toastLoginFailed", { name: report.label }), "warning");
      return;
    }
    // A confirmed session with nothing to fill is the expected quiet outcome —
    // announcing every already-signed-in launch would be six toasts for one view.
    if (report.filled && report.loggedIn) {
      notify(tr("app.toastAutoLoggedIn", { name: report.label }), "success");
      return;
    }
    if (!report.filled) return;
    const separator = tr("app.listSeparator");
    const notes = [tr("app.toastAutoFilled", { name: report.label })];
    if (report.missingFields.length > 0) {
      notes.push(tr("app.toastMissingFields", { fields: report.missingFields.join(separator) }));
    }
    if (report.unmatchedFields.length > 0) {
      notes.push(
        tr("app.toastUnmatchedFields", { fields: report.unmatchedFields.join(separator) }),
      );
    }
    notify(notes.join(" · "), report.missingFields.length > 0 ? "info" : "success");
  }

  /**
   * The site's address changed since the last successful fill.
   *
   * The password is not sent until the user says "yes, this origin is still the
   * intended site". Accepting records the new origin, so this asks once per real
   * change rather than on every launch.
   */
  async function confirmChangedOrigin(report: AutoFillReport): Promise<void> {
    const notice = await window.ensemble.takeOriginNotice();
    if (!notice) {
      notify(tr("app.toastOriginChanged", { name: report.label }), "error");
      return;
    }
    const accepted = await confirm.ask({
      title: tr("app.confirmOriginTitle"),
      body: tr("app.confirmOriginChange", {
        site: notice.siteName,
        expected: notice.expectedOrigin,
        current: notice.currentOrigin,
      }),
      confirmLabel: tr("app.confirmOriginAccept"),
      tone: "danger",
    });
    if (!accepted) {
      notify(tr("app.toastOriginRejected", { name: notice.siteName }), "error");
      return;
    }
    const site = sites.value.find((item) => item.id === notice.siteId);
    if (!site) return;
    await acceptSiteOrigin(site.id);
    notify(tr("app.toastOriginAccepted", { site: notice.siteName }), "success");
  }

  function notify(text: string, tone: ToastMessage["tone"] = "info") {
    const id = ++toastSeq;
    toasts.value = [...toasts.value, { id, text, tone }];
    setTimeout(() => {
      toasts.value = toasts.value.filter((toast) => toast.id !== id);
    }, 4200);
  }

  async function run<T>(
    key: string,
    task: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> {
    busy.value = key;
    try {
      const result = await task();
      if (success) notify(success, "success");
      return result;
    } catch (error) {
      // Electron wraps IPC rejections as "Error invoking remote method 'x': Error: …";
      // the wrapper means nothing to the user, so show only the real message.
      notify(
        (error as Error).message.replace(
          /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
          "",
        ),
        "error",
      );
      return undefined;
    } finally {
      busy.value = null;
    }
  }

  const sites = computed<Site[]>(() => snapshot.value?.sites ?? []);
  const identities = computed<Identity[]>(() => snapshot.value?.identities ?? []);
  const views = computed<View[]>(() => snapshot.value?.views ?? []);
  const flows = computed<Flow[]>(() => snapshot.value?.flows ?? []);
  /** Plain bookmarks in stored order; the main process already sorted them. */
  const bookmarks = computed<Bookmark[]>(() => snapshot.value?.bookmarks ?? []);
  const engines = computed<Engine[]>(() => snapshot.value?.engines ?? []);
  const enginesReady = computed(() => snapshot.value?.enginesReady ?? true);
  const settings = computed<AppSettings>(
    () =>
      snapshot.value?.settings ?? {
        theme: "dark",
        locale: "zh",
        lastView: "identities",
        restoreLastView: false,
        overlayEnabled: true,
        headlessCheckUa: "desktop",
        focusLabelEnabled: true,
        launchIntervalMs: 0,
        layout: "2x2",
        launchTarget: "embedded",
        autoFillOnLaunch: true,
        autoSubmitLogin: true,
        browserZoom: 100,
        searchEngineId: DEFAULT_SEARCH_ENGINE_ID,
        customSearchEngines: [],
        newTabBackground: DEFAULT_NEW_TAB_BACKDROP,
        newTabBookmarks: true,
        closeToTray: true,
        onboardingVersion: 0,
        autoCheckUpdates: true,
      },
  );
  const instances = computed(() => snapshot.value?.instances ?? []);
  const credentials = computed(() => snapshot.value?.credentials);

  /** Built-in presets first, then whatever the user saved. */
  const layoutPresets = computed<LayoutPreset[]>(() => [
    ...BUILTIN_LAYOUTS,
    ...(snapshot.value?.layoutPresets ?? []),
  ]);

  /**
   * Engines a new tab can search with: the built-ins in code plus the user's.
   *
   * Built-ins live in code rather than in the store so an upgrade can fix a URL
   * without a migration, and so a fresh install has something to search with
   * before settings have ever been written.
   */
  const searchEngines = computed<SearchEngine[]>(() => [
    ...SEARCH_ENGINES,
    ...(settings.value.customSearchEngines ?? []),
  ]);

  /** The engine the new-tab box uses; falls back if the choice disappeared. */
  const searchEngine = computed<SearchEngine>(() => {
    const id = settings.value.searchEngineId || DEFAULT_SEARCH_ENGINE_ID;
    return (
      searchEngines.value.find((engine) => engine.id === id) ??
      searchEngines.value.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE_ID) ??
      SEARCH_ENGINES[0]!
    );
  });

  /** Backdrop of the new-tab surface; a stale id falls back, it never throws. */
  const newTabBackdropStyle = computed(
    () => newTabBackdrop(settings.value.newTabBackground || DEFAULT_NEW_TAB_BACKDROP).css,
  );

  /**
   * The site a new draft defaults to.
   *
   * There is no global "current site": the embedded browser takes any address,
   * and a view spans sites. This is only the last site the user worked with, so
   * "new identity" can pre-select something sensible.
   */
  const defaultSite = computed<Site | undefined>(
    () => sites.value.find((site) => site.id === recentSiteId.value) ?? sites.value[0],
  );

  /**
   * The browser external launches use.
   *
   * One global setting, matching the title bar's single switch. It used to be
   * derived from whichever site was used last, so the browser name shown in the
   * switch changed when the user moved between sites — while accounts from
   * different sites were meant to launch into the same surface.
   */
  const defaultEngine = computed<Engine | undefined>(() => {
    const preferredId = settings.value.defaultEngineId;
    return (
      engines.value.find((engine) => engine.id === preferredId) ??
      engines.value.find((engine) => engine.cdp && engine.status === "ready") ??
      engines.value.find((engine) => engine.cdp) ??
      engines.value[0]
    );
  });

  function markSiteUsed(id: string) {
    recentSiteId.value = id;
    void window.ensemble.saveSettings({ lastSiteId: id });
  }

  /** Identities of a site, in stored order. */
  function identitiesOf(siteId: string): Identity[] {
    return identities.value.filter((identity) => identity.siteId === siteId);
  }

  /** Identity counts per site, for the account page's group headers. */
  const identityCountBySite = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const identity of identities.value) {
      // An account with no site has no group; the page counts those separately.
      if (!identity.siteId) continue;
      counts[identity.siteId] = (counts[identity.siteId] ?? 0) + 1;
    }
    return counts;
  });

  /**
   * Tags that apply to an identity: its own plus its site's.
   *
   * Filtering with either level means a tag on the site covers every account
   * there, without copying it onto each identity.
   */
  function tagsForIdentity(identity: Identity): string[] {
    const site = sites.value.find((item) => item.id === identity.siteId);
    return [...new Set([...(identity.tagIds ?? []), ...(site?.tagIds ?? [])])];
  }

  /** Tags of a view: its own plus every member's identity and site tags. */
  function tagsForView(view: View): string[] {
    const collected = new Set<string>(view.tagIds ?? []);
    for (const identityId of view.identityIds) {
      const identity = identities.value.find((item) => item.id === identityId);
      if (!identity) continue;
      for (const tagId of tagsForIdentity(identity)) collected.add(tagId);
    }
    return [...collected];
  }

  function identityPasswordSet(identity: Identity): boolean {
    if (identity.passwordMode === "reference") {
      // A reference never owns a credential: it resolves through its source,
      // which may itself fall back to the source site's default password.
      const source = identity.credentialFrom
        ? identities.value.find((item) => item.id === identity.credentialFrom)
        : undefined;
      return source ? identityPasswordSet(source) : false;
    }
    if (identity.passwordMode === "custom") {
      return Boolean(credentials.value?.identity[identity.id]);
    }
    // An account with no site has no site default to inherit.
    const siteId = identity.siteId;
    if (!siteId) return false;
    return Boolean(credentials.value?.site[siteId]);
  }

  function instanceFor(identityId: string) {
    return instances.value.find((instance) => instance.identityId === identityId);
  }

  function engineFor(identity: Identity): Engine | undefined {
    // An identity may override the global browser; otherwise the global default
    // decides, exactly like the main service does.
    const id = identity.engineId ?? settings.value.defaultEngineId;
    return engines.value.find((engine) => engine.id === id) ?? defaultEngine.value;
  }

  function presetById(id: LayoutId | undefined): LayoutPreset {
    // "1 × 1" and "no layout" are the same single full-stage cell once embedded
    // views exist, so legacy definitions that saved 1x1 read back as free.
    return findLayout(id === "1x1" ? FREE_LAYOUT_ID : id, snapshot.value?.layoutPresets ?? []);
  }

  /** Presets offered for a view: "1 × 1" is folded into "no layout". */
  const viewLayoutPresets = computed<LayoutPreset[]>(() =>
    layoutPresets.value.filter((preset) => preset.id !== "1x1"),
  );

  /** The no-layout preset is the only built-in whose name needs translating. */
  function presetName(preset: LayoutPreset): string {
    return preset.id === FREE_LAYOUT_ID ? tr("app.freeLayoutName") : preset.name;
  }

  function toPlain<T>(value: T): T {
    // Drafts originate from Vue reactive objects. Their nested arrays/records stay
    // Proxy-wrapped, and the IPC structured-clone algorithm rejects Proxies with
    // "An object could not be cloned". Drafts are JSON data, so a round trip is safe.
    return JSON.parse(JSON.stringify(value)) as T;
  }

  async function saveSite(draft: SiteDraft) {
    return run("site", () => window.ensemble.saveSite(toPlain(draft)), tr("app.toastSiteSaved"));
  }

  async function deleteSite(id: string) {
    return run("site", () => window.ensemble.deleteSite(id));
  }

  async function saveTag(draft: TagDraft) {
    return run("site", () => window.ensemble.saveTag(toPlain(draft)));
  }

  async function deleteTag(id: string) {
    return run("site", () => window.ensemble.deleteTag(id));
  }

  async function saveIdentity(draft: IdentityDraft) {
    return run(
      "identity",
      () => window.ensemble.saveIdentity(toPlain(draft)),
      tr("app.toastIdentitySaved"),
    );
  }

  async function deleteIdentity(id: string) {
    return run("identity", () => window.ensemble.deleteIdentity(id));
  }

  /** Points a batch of accounts at one site; the message names the count. */
  async function linkIdentitiesToSite(identityIds: string[], siteId: string) {
    const site = sites.value.find((item) => item.id === siteId);
    const result = await run(
      "identity",
      () => window.ensemble.linkIdentitiesToSite(identityIds, siteId),
      tr("app.toastIdentitiesLinked", {
        count: identityIds.length,
        site: site?.name ?? "",
      }),
    );
    return result;
  }

  async function rebuildIdentityProfile(id: string) {
    return run(
      "identity",
      () => window.ensemble.rebuildIdentityProfile(id),
      tr("app.toastProfileCleared"),
    );
  }

  /** Turns a reference into a standalone copy; the resolved password is kept. */
  async function detachReference(id: string) {
    return run(
      "identity",
      () => window.ensemble.detachReference(id),
      tr("app.toastReferenceDetached"),
    );
  }

  /** Accepts a changed site address; the next fill is allowed again. */
  async function acceptSiteOrigin(siteId: string) {
    return run("site", () => window.ensemble.acceptSiteOrigin(siteId));
  }

  async function takeOriginNotice() {
    return window.ensemble.takeOriginNotice();
  }

  /** Copies a view onto another site, referencing accounts where needed. */
  async function copyViewToSite(viewId: string, targetSiteId: string) {
    return run("view", () => window.ensemble.copyViewToSite(viewId, targetSiteId));
  }

  async function saveView(draft: ViewDraft) {
    return run("view", () => window.ensemble.saveView(toPlain(draft)), tr("app.toastViewSaved"));
  }

  async function deleteView(id: string) {
    return run("view", () => window.ensemble.deleteView(id));
  }

  /**
   * Drag-to-reorder for the views list.
   *
   * Applies the returned snapshot instead of waiting for the broadcast: the row
   * the user just dropped has to stay where they put it, and a re-broadcast that
   * lands a frame later would let the list visibly snap back first.
   */
  async function moveView(id: string, toIndex: number) {
    return run("view", async () => {
      const next = await window.ensemble.moveView(id, toIndex);
      apply(next);
      return next;
    });
  }

  async function saveFlow(draft: FlowDraft) {
    return run("flow", () => window.ensemble.saveFlow(toPlain(draft)));
  }

  async function deleteFlow(id: string) {
    return run("flow", () => window.ensemble.deleteFlow(id));
  }

  /*
   * Bookmark mutations apply the returned snapshot instead of waiting for the
   * broadcast: the star reads `bookmarks` right after adding, and an event that
   * has not landed yet would make the follow-up icon write miss its target.
   */
  async function saveBookmark(draft: BookmarkDraft) {
    return run("bookmark", async () => {
      const next = await window.ensemble.saveBookmark(toPlain(draft));
      apply(next);
      return next;
    });
  }

  async function setBookmarkFavicon(id: string, favicon?: string) {
    return run("bookmark", async () => {
      apply(await window.ensemble.setBookmarkFavicon(id, favicon));
    });
  }

  async function deleteBookmark(id: string) {
    return run("bookmark", async () => {
      apply(await window.ensemble.deleteBookmark(id));
    });
  }

  async function moveBookmark(id: string, toIndex: number) {
    return run("bookmark", async () => {
      apply(await window.ensemble.moveBookmark(id, toIndex));
    });
  }

  /**
   * Runs a flow and reports the outcome.
   *
   * A failed step is not an IPC error — the run completed and says where it
   * stopped — so this returns the result rather than letting `run` swallow it.
   */
  async function runFlow(input: {
    flowId: string;
    identityId?: string;
    params?: Record<string, string>;
    tabId?: string;
  }) {
    return run("flow", () => window.ensemble.runFlow(toPlain(input)));
  }

  /** Changes the stored preset of one view without opening its dialog. */
  async function setViewLayout(viewId: string, layoutId: LayoutId) {
    return run("view", () => window.ensemble.setViewLayout(viewId, layoutId));
  }

  /** identityId -> slot index, written whenever a chip is dropped on a slot. */
  async function setViewSlots(viewId: string, assignments: Record<string, number>) {
    return run("view", async () => {
      const next = await window.ensemble.setViewSlotAssignments(viewId, toPlain(assignments));
      // Windows already open should move with the chips, not wait for a relaunch.
      if (
        next.instances.some(
          (instance) => instance.identityId && assignments[instance.identityId] !== undefined,
        )
      ) {
        await window.ensemble.retileView(viewId);
      }
      return next;
    });
  }

  async function saveLayoutPreset(draft: LayoutPresetDraft): Promise<LayoutPreset | undefined> {
    return run(
      "layout",
      () => window.ensemble.saveLayoutPreset(toPlain(draft)),
      tr("app.toastLayoutSaved"),
    );
  }

  async function deleteLayoutPreset(id: LayoutId) {
    return run(
      "layout",
      () => window.ensemble.deleteLayoutPreset(id),
      tr("app.toastLayoutDeleted"),
    );
  }

  async function scanEngines() {
    return run("scan", async () => {
      const engines = await window.ensemble.scanEngines();
      notify(tr("app.toastScanDone", { count: engines.length }), "success");
      return engines;
    });
  }

  async function addManualEngine() {
    return run("scan", async () => {
      const engines = await window.ensemble.addManualEngine();
      notify(tr("app.toastManualAdded"), "success");
      return engines;
    });
  }

  async function removeManualEngine(exePath: string) {
    return run("scan", () => window.ensemble.removeManualEngine(exePath));
  }

  async function launchIdentity(identityId: string, pathOverride?: string) {
    return run("launch", () => window.ensemble.launchIdentity(identityId, pathOverride));
  }

  /** Opens several identities at once, tiled with the default layout. */
  async function launchIdentities(identityIds: string[]) {
    return run("launch", async () => {
      const result = await window.ensemble.launchIdentities(identityIds);
      notify(tr("app.toastBatchStarted"), "success");
      return result;
    });
  }

  async function launchView(viewId: string) {
    return run("launch", () => window.ensemble.launchView(viewId), tr("app.toastViewStarted"));
  }

  async function launchViewMember(viewId: string, identityId: string) {
    return run("launch", () => window.ensemble.launchViewMember(viewId, identityId));
  }

  /**
   * Pass an site id for a clean window on that login page; omit it for a
   * blank tab that belongs to no site.
   *
   * Always the external surface: this is the service's throwaway browser window.
   * Callers that should follow the title bar's launch target use
   * `openCleanSession` instead.
   */
  async function launchCleanSession(siteId?: string) {
    return run("launch", async () => {
      const result = await window.ensemble.launchCleanSession(siteId);
      notify(tr("app.toastCleanOpened"), "success");
      return result;
    });
  }

  /**
   * Opens a clean session on whichever surface the title bar points at.
   *
   * A clean session is a session, not a window type: "throwaway, signed out"
   * applies equally to a built-in page and to a separate browser window. Routing
   * it through the global switch is the point — the old per-page buttons always
   * launched the external browser, even with the switch set to the built-in
   * surface, so clicking "blank clean session" opened Edge out of nowhere.
   */
  async function openCleanSession(): Promise<void> {
    if (settings.value.launchTarget === "embedded") {
      // A loose tab, so it does not silently join whatever view is on stage:
      // a throwaway page is not part of the comparison being arranged there.
      await window.ensemble.openEmbeddedTab({ viewId: null, clean: true });
      notify(tr("app.toastCleanOpened"), "success");
      return;
    }
    await launchCleanSession();
  }

  /** Opens a clean session on the most recently used site's login page. */
  async function stopInstance(id: string) {
    return run("stop", () => window.ensemble.stopInstance(id));
  }

  /** Raises the browser window behind an instance; no relaunch, no reload. */
  async function focusInstance(id: string): Promise<boolean> {
    return window.ensemble.focusInstance(id);
  }

  async function stopAll() {
    return run("stop", async () => {
      await window.ensemble.stopAll();
      notify(tr("app.toastAllClosed"), "success");
    });
  }

  /** Closes only the windows this view opened. */
  async function stopView(viewId: string) {
    return run("stop", async () => {
      await window.ensemble.stopView(viewId);
      notify(tr("app.toastViewClosed"), "success");
    });
  }

  async function checkAuth(identityId: string): Promise<AuthCheckResult | undefined> {
    return run("auth", async () => {
      const result = await window.ensemble.checkAuth(identityId);
      notify(result.detail ?? "", result.status === "expired" ? "error" : "info");
      return result;
    });
  }

  async function fillLogin(identityId: string): Promise<AuthCheckResult | undefined> {
    return run("auth", async () => {
      const result = await window.ensemble.fillLogin(identityId);
      notify(result.detail ?? tr("app.toastFilled"), "success");
      return result;
    });
  }

  async function checkAllAuth(siteId?: string): Promise<AuthBatchResult | undefined> {
    return run("auth-check-all", async () => {
      const result = await window.ensemble.checkAllAuth(siteId);
      notify(
        tr("app.toastCheckedAll", {
          signedIn: result.totals.signedIn,
          expired: result.totals.expired,
          unknown: result.totals.unknown,
        }),
        result.totals.expired > 0 ? "error" : "success",
      );
      return result;
    });
  }

  async function reloginExpired(siteId?: string): Promise<ReloginBatchResult | undefined> {
    return run("auth-relogin", async () => {
      const result = await window.ensemble.reloginExpired(siteId);
      notify(
        tr("app.toastReloginDone", {
          succeeded: result.succeeded,
          attempted: result.attempted,
        }),
        result.succeeded === result.attempted ? "success" : "info",
      );
      return result;
    });
  }

  async function setPassword(owner: PasswordOwner, password: string) {
    return run(
      "password",
      () => window.ensemble.setPassword(owner, password),
      tr("app.toastPasswordSaved"),
    );
  }

  async function clearPassword(owner: PasswordOwner) {
    return run("password", () => window.ensemble.clearPassword(owner));
  }

  async function copyPassword(owner: PasswordOwner) {
    const copied = await window.ensemble.copyPassword(owner);
    notify(
      copied ? tr("app.toastCopied") : tr("app.toastNothingToCopy"),
      copied ? "success" : "error",
    );
  }

  async function unlockVault(password: string): Promise<boolean> {
    const unlocked = await window.ensemble.unlockVault(password);
    notify(
      unlocked ? tr("app.toastVaultUnlocked") : tr("app.toastWrongMaster"),
      unlocked ? "success" : "error",
    );
    return unlocked;
  }

  async function lockVault() {
    return run("password", async () => {
      apply(await window.ensemble.lockVault());
      notify(tr("app.toastVaultLocked"), "success");
    });
  }

  async function setMasterPassword(password: string) {
    return run("password", async () => {
      const next = await window.ensemble.setMasterPassword(password);
      apply(next);
      notify(tr("app.toastMasterEnabled"), "success");
    });
  }

  async function removeMasterPassword() {
    return run("password", async () => {
      const next = await window.ensemble.removeMasterPassword();
      apply(next);
      notify(tr("app.toastMasterRemoved"), "success");
    });
  }

  async function changeMasterPassword(current: string, next: string): Promise<boolean> {
    const changed = await window.ensemble.changeMasterPassword(current, next);
    notify(
      changed ? tr("app.toastMasterChanged") : tr("app.toastWrongMaster"),
      changed ? "success" : "error",
    );
    return changed;
  }

  async function saveSettings(patch: SettingsPatch) {
    return run("settings", () => window.ensemble.saveSettings(toPlain(patch)));
  }

  async function exportWorkspace(options: { includeSecrets: boolean; passphrase?: string }) {
    return run("transfer", () => window.ensemble.exportWorkspace(toPlain(options)));
  }

  async function pickImport() {
    return run("transfer", () => window.ensemble.pickImport());
  }

  async function applyImport(passphrase?: string) {
    return run("transfer", async () => {
      const result = await window.ensemble.applyImport(passphrase);
      notify(
        tr("app.toastImportDone", { added: result.added, updated: result.updated }),
        "success",
      );
      return result;
    });
  }

  async function mcpStatus() {
    mcp.value = await window.ensemble.mcpStatus();
    return mcp.value;
  }

  async function updateMcp(patch: McpPatch) {
    const next = await run("mcp", () => window.ensemble.updateMcp(toPlain(patch)));
    if (next) mcp.value = next;
    return next;
  }

  return {
    snapshot,
    loading,
    busy,
    toasts,
    loginCapture,
    dismissLoginCapture,
    clearLoginCapture,
    mcp,
    aiActions,
    lastAiOrigin,
    sites,
    identities,
    views,
    engines,
    enginesReady,
    settings,
    bookmarks,
    instances,
    credentials,
    defaultSite,
    recentSiteId,
    identitiesOf,
    identityCountBySite,
    tagsForIdentity,
    tagsForView,
    markSiteUsed,
    defaultEngine,
    layoutPresets,
    searchEngines,
    searchEngine,
    newTabBackdropStyle,
    api,
    init,
    notify,
    identityPasswordSet,
    instanceFor,
    engineFor,
    presetById,
    presetName,
    viewLayoutPresets,
    isFreeLayout,
    flows,
    saveSite,
    deleteSite,
    saveTag,
    deleteTag,
    saveIdentity,
    deleteIdentity,
    linkIdentitiesToSite,
    rebuildIdentityProfile,
    detachReference,
    acceptSiteOrigin,
    takeOriginNotice,
    copyViewToSite,
    saveView,
    deleteView,
    moveView,
    saveFlow,
    deleteFlow,
    saveBookmark,
    setBookmarkFavicon,
    deleteBookmark,
    moveBookmark,
    runFlow,
    setViewLayout,
    setViewSlots,
    saveLayoutPreset,
    deleteLayoutPreset,
    scanEngines,
    addManualEngine,
    removeManualEngine,
    launchIdentity,
    launchIdentities,
    launchView,
    launchViewMember,
    launchCleanSession,
    openCleanSession,
    stopInstance,
    stopAll,
    stopView,
    focusInstance,
    checkAuth,
    checkAllAuth,
    reloginExpired,
    fillLogin,
    setPassword,
    clearPassword,
    copyPassword,
    unlockVault,
    lockVault,
    setMasterPassword,
    removeMasterPassword,
    changeMasterPassword,
    saveSettings,
    exportWorkspace,
    pickImport,
    applyImport,
    mcpStatus,
    updateMcp,
  };
});
