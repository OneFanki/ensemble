import type { EnsembleApi } from "@shared/ipc";
import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID, findLayout, isFreeLayout } from "@shared/layouts";
import type {
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  Engine,
  Identity,
  IdentityDraft,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  McpPatch,
  PasswordOwner,
  ReloginBatchResult,
  SettingsPatch,
  Site,
  SiteDraft,
  SiteTagDraft,
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
  tone: "info" | "error" | "success";
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const snapshot = ref<WorkspaceSnapshot | null>(null);
  const loading = ref(true);
  const busy = ref<string | null>(null);
  const toasts = ref<ToastMessage[]>([]);
  const activeSiteId = ref<string | null>(null);
  let toastSeq = 0;

  const api = computed(() => window.ensemble);
  const confirm = useConfirmStore();

  function apply(next: WorkspaceSnapshot) {
    snapshot.value = next;
    if (!activeSiteId.value || !next.sites.some((env) => env.id === activeSiteId.value)) {
      activeSiteId.value = next.settings.lastSiteId ?? next.sites[0]?.id ?? null;
    }
  }

  async function init() {
    loading.value = true;
    try {
      apply(await window.ensemble.getWorkspace());
      window.ensemble.onWorkspaceChanged((next) => apply(next));
      window.ensemble.onAutoFilled((report) => announceAutoFill(report));
    } finally {
      loading.value = false;
    }
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
        autoFillOnLaunch: true,
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

  const activeSite = computed<Site | undefined>(
    () => sites.value.find((env) => env.id === activeSiteId.value) ?? sites.value[0],
  );

  const siteIdentities = computed<Identity[]>(() => {
    const envId = activeSite.value?.id;
    if (!envId) return [];
    return identities.value.filter((identity) => identity.siteId === envId);
  });

  const siteViews = computed<View[]>(() =>
    views.value.filter((view) => view.siteId === activeSite.value?.id),
  );

  const defaultEngine = computed<Engine | undefined>(() => {
    const preferredId = activeSite.value?.defaultEngineId;
    return (
      engines.value.find((engine) => engine.id === preferredId) ??
      engines.value.find((engine) => engine.cdp && engine.status === "ready") ??
      engines.value.find((engine) => engine.cdp)
    );
  });

  function setActiveSite(id: string) {
    activeSiteId.value = id;
    void window.ensemble.saveSettings({ lastSiteId: id });
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
    const siteId = identity.siteId;
    return Boolean(credentials.value?.site[siteId]);
  }

  function instanceFor(identityId: string) {
    return instances.value.find((instance) => instance.identityId === identityId);
  }

  function engineFor(identity: Identity): Engine | undefined {
    const id = identity.engineId ?? activeSite.value?.defaultEngineId;
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

  async function saveSiteTag(draft: SiteTagDraft) {
    return run("site", () => window.ensemble.saveSiteTag(toPlain(draft)));
  }

  async function deleteSiteTag(id: string) {
    return run("site", () => window.ensemble.deleteSiteTag(id));
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
   */
  async function launchCleanSession(siteId?: string) {
    return run("launch", async () => {
      const result = await window.ensemble.launchCleanSession(siteId);
      notify(tr("app.toastCleanOpened"), "success");
      return result;
    });
  }

  /** Convenience wrapper for the views scoped to the active site. */
  async function launchScopedCleanSession() {
    return launchCleanSession(activeSite.value?.id);
  }

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
    return window.ensemble.mcpStatus();
  }

  async function updateMcp(patch: McpPatch) {
    return run("mcp", () => window.ensemble.updateMcp(toPlain(patch)));
  }

  return {
    snapshot,
    loading,
    busy,
    toasts,
    sites,
    identities,
    views,
    engines,
    enginesReady,
    settings,
    instances,
    credentials,
    activeSite,
    activeSiteId,
    siteIdentities,
    siteViews,
    defaultEngine,
    layoutPresets,
    api,
    init,
    notify,
    setActiveSite,
    identityPasswordSet,
    instanceFor,
    engineFor,
    presetById,
    presetName,
    viewLayoutPresets,
    isFreeLayout,
    saveSite,
    deleteSite,
    saveSiteTag,
    deleteSiteTag,
    saveIdentity,
    deleteIdentity,
    rebuildIdentityProfile,
    detachReference,
    acceptSiteOrigin,
    takeOriginNotice,
    copyViewToSite,
    saveView,
    deleteView,
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
    launchScopedCleanSession,
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
