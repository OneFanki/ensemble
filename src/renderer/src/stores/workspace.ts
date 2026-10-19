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
  LayoutKey,
  PasswordOwner,
  Scene,
  SceneDraft,
  SettingsPatch,
  WorkspaceSnapshot,
} from "@shared/types";
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
    if (!activeEnvironmentId.value || !next.environments.some((env) => env.id === activeEnvironmentId.value)) {
      activeEnvironmentId.value =
        next.settings.lastEnvironmentId ??
        next.environments[0]?.id ??
        null;
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
      notes.push(tr("app.toastUnmatchedFields", { fields: report.unmatchedFields.join(separator) }));
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

  async function run<T>(key: string, task: () => Promise<T>, success?: string): Promise<T | undefined> {
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
      },
  );
  const instances = computed(() => snapshot.value?.instances ?? []);
  const credentials = computed(() => snapshot.value?.credentials);

  const activeEnvironment = computed<Environment | undefined>(
    () => environments.value.find((env) => env.id === activeEnvironmentId.value) ?? environments.value[0],
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

  function toPlain<T>(value: T): T {
    // Drafts originate from Vue reactive objects. Their nested arrays/records stay
    // Proxy-wrapped, and the IPC structured-clone algorithm rejects Proxies with
    // "An object could not be cloned". Drafts are JSON data, so a round trip is safe.
    return JSON.parse(JSON.stringify(value)) as T;
  }

  async function saveEnvironment(draft: EnvironmentDraft) {
    return run("environment", () => window.ensemble.saveEnvironment(toPlain(draft)), tr("app.toastEnvSaved"));
  }

  async function deleteEnvironment(id: string) {
    return run("environment", () => window.ensemble.deleteEnvironment(id));
  }

  async function saveIdentity(draft: IdentityDraft) {
    return run("identity", () => window.ensemble.saveIdentity(toPlain(draft)), tr("app.toastIdentitySaved"));
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

  /** Changes the stored layout of one scene without opening its dialog. */
  async function setSceneLayout(sceneId: string, layout: LayoutKey) {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return;
    return run("scene", () =>
      window.ensemble.saveScene(
        toPlain({
          id: scene.id,
          environmentId: scene.environmentId,
          name: scene.name,
          identityIds: [...scene.identityIds],
          layout,
          paths: { ...scene.paths },
        }),
      ),
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

  async function launchCleanSession() {
    const envId = activeEnvironment.value?.id;
    if (!envId) {
      notify(tr("app.toastNeedEnvironment"), "error");
      return;
    }
    return run("launch", async () => {
      const result = await window.ensemble.launchCleanSession(envId);
      notify(tr("app.toastCleanOpened"), "success");
      return result;
    });
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
    return run("password", () => window.ensemble.setPassword(owner, password), tr("app.toastPasswordSaved"));
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

  function setLayout(layout: LayoutKey) {
    void saveSettings({ layout });
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
    api,
    init,
    notify,
    setActiveEnvironment,
    identityPasswordSet,
    instanceFor,
    engineFor,
    saveEnvironment,
    deleteEnvironment,
    saveIdentity,
    deleteIdentity,
    rebuildIdentityProfile,
    saveScene,
    deleteScene,
    scanEngines,
    addManualEngine,
    removeManualEngine,
    launchIdentity,
    launchScene,
    launchCleanSession,
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
    setLayout,
    setSceneLayout,
  };
});
