import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AppSettings,
  AuthCheckResult,
  AutoFillReport,
  Engine,
  Environment,
  EnvironmentDraft,
  Identity,
  IdentityDraft,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  McpPatch,
  PasswordOwner,
  Scene,
  SceneDraft,
  SettingsPatch,
  WorkspaceSnapshot,
} from "@shared/types";
import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID, findLayout, isFreeLayout } from "@shared/layouts";
import type { EnsembleApi } from "@shared/ipc";
import { tr } from "../i18n";

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
  const activeEnvironmentId = ref<string | null>(null);
  let toastSeq = 0;

  const api = computed(() => window.ensemble);

  function apply(next: WorkspaceSnapshot) {
    snapshot.value = next;
    if (
      !activeEnvironmentId.value ||
      !next.environments.some((env) => env.id === activeEnvironmentId.value)
    ) {
      activeEnvironmentId.value =
        next.settings.lastEnvironmentId ?? next.environments[0]?.id ?? null;
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
      notify((error as Error).message, "error");
      return undefined;
    } finally {
      busy.value = null;
    }
  }

  const environments = computed<Environment[]>(() => snapshot.value?.environments ?? []);
  const identities = computed<Identity[]>(() => snapshot.value?.identities ?? []);
  const scenes = computed<Scene[]>(() => snapshot.value?.scenes ?? []);
  const engines = computed<Engine[]>(() => snapshot.value?.engines ?? []);
  const enginesReady = computed(() => snapshot.value?.enginesReady ?? true);
  const settings = computed<AppSettings>(
    () =>
      snapshot.value?.settings ?? {
        theme: "dark",
        locale: "zh",
        lastView: "identities",
        layout: "2x2",
        autoFillOnLaunch: true,
        closeToTray: true,
      },
  );
  const instances = computed(() => snapshot.value?.instances ?? []);
  const credentials = computed(() => snapshot.value?.credentials);

  /** Built-in presets first, then whatever the user saved. */
  const layoutPresets = computed<LayoutPreset[]>(() => [
    ...BUILTIN_LAYOUTS,
    ...(snapshot.value?.layoutPresets ?? []),
  ]);

  const activeEnvironment = computed<Environment | undefined>(
    () =>
      environments.value.find((env) => env.id === activeEnvironmentId.value) ??
      environments.value[0],
  );

  const environmentIdentities = computed<Identity[]>(() => {
    const envId = activeEnvironment.value?.id;
    if (!envId) return [];
    return identities.value.filter((identity) => identity.environmentId === envId);
  });

  const environmentScenes = computed<Scene[]>(() =>
    scenes.value.filter((scene) => scene.environmentId === activeEnvironment.value?.id),
  );

  const defaultEngine = computed<Engine | undefined>(() => {
    const preferredId = activeEnvironment.value?.defaultEngineId;
    return (
      engines.value.find((engine) => engine.id === preferredId) ??
      engines.value.find((engine) => engine.cdp && engine.status === "ready") ??
      engines.value.find((engine) => engine.cdp)
    );
  });

  function setActiveEnvironment(id: string) {
    activeEnvironmentId.value = id;
    void window.ensemble.saveSettings({ lastEnvironmentId: id });
  }

  function identityPasswordSet(identity: Identity): boolean {
    if (identity.passwordMode === "custom") {
      return Boolean(credentials.value?.identity[identity.id]);
    }
    const envId = identity.environmentId;
    return Boolean(credentials.value?.environment[envId]);
  }

  function instanceFor(identityId: string) {
    return instances.value.find((instance) => instance.identityId === identityId);
  }

  function engineFor(identity: Identity): Engine | undefined {
    const id = identity.engineId ?? activeEnvironment.value?.defaultEngineId;
    return engines.value.find((engine) => engine.id === id) ?? defaultEngine.value;
  }

  function presetById(id: LayoutId | undefined): LayoutPreset {
    return findLayout(id, snapshot.value?.layoutPresets ?? []);
  }

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

  async function saveEnvironment(draft: EnvironmentDraft) {
    return run(
      "environment",
      () => window.ensemble.saveEnvironment(toPlain(draft)),
      tr("app.toastEnvSaved"),
    );
  }

  async function deleteEnvironment(id: string) {
    return run("environment", () => window.ensemble.deleteEnvironment(id));
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

  async function saveScene(draft: SceneDraft) {
    return run("scene", () => window.ensemble.saveScene(toPlain(draft)), tr("app.toastSceneSaved"));
  }

  async function deleteScene(id: string) {
    return run("scene", () => window.ensemble.deleteScene(id));
  }

  /** Changes the stored preset of one scene without opening its dialog. */
  async function setSceneLayout(sceneId: string, layoutId: LayoutId) {
    return run("scene", () => window.ensemble.setSceneLayout(sceneId, layoutId));
  }

  /** identityId -> slot index, written whenever a chip is dropped on a slot. */
  async function setSceneSlots(sceneId: string, assignments: Record<string, number>) {
    return run("scene", async () => {
      const next = await window.ensemble.setSceneSlotAssignments(sceneId, toPlain(assignments));
      // Windows already open should move with the chips, not wait for a relaunch.
      if (
        next.instances.some(
          (instance) => instance.identityId && assignments[instance.identityId] !== undefined,
        )
      ) {
        await window.ensemble.retileScene(sceneId);
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

  async function launchScene(sceneId: string) {
    return run("launch", () => window.ensemble.launchScene(sceneId), tr("app.toastSceneStarted"));
  }

  async function launchSceneMember(sceneId: string, identityId: string) {
    return run("launch", () => window.ensemble.launchSceneMember(sceneId, identityId));
  }

  /**
   * Pass an environment id for a clean window on that login page; omit it for a
   * blank tab that belongs to no environment.
   */
  async function launchCleanSession(environmentId?: string) {
    return run("launch", async () => {
      const result = await window.ensemble.launchCleanSession(environmentId);
      notify(tr("app.toastCleanOpened"), "success");
      return result;
    });
  }

  /** Convenience wrapper for the views scoped to the active environment. */
  async function launchScopedCleanSession() {
    return launchCleanSession(activeEnvironment.value?.id);
  }

  async function stopInstance(id: string) {
    return run("stop", () => window.ensemble.stopInstance(id));
  }

  async function stopAll() {
    return run("stop", async () => {
      await window.ensemble.stopAll();
      notify(tr("app.toastAllClosed"), "success");
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
    environments,
    identities,
    scenes,
    engines,
    enginesReady,
    settings,
    instances,
    credentials,
    activeEnvironment,
    activeEnvironmentId,
    environmentIdentities,
    environmentScenes,
    defaultEngine,
    layoutPresets,
    api,
    init,
    notify,
    setActiveEnvironment,
    identityPasswordSet,
    instanceFor,
    engineFor,
    presetById,
    presetName,
    isFreeLayout,
    saveEnvironment,
    deleteEnvironment,
    saveIdentity,
    deleteIdentity,
    rebuildIdentityProfile,
    saveScene,
    deleteScene,
    setSceneLayout,
    setSceneSlots,
    saveLayoutPreset,
    deleteLayoutPreset,
    scanEngines,
    addManualEngine,
    removeManualEngine,
    launchIdentity,
    launchScene,
    launchSceneMember,
    launchCleanSession,
    launchScopedCleanSession,
    stopInstance,
    stopAll,
    checkAuth,
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
