import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AppSettings,
  AuthCheckResult,
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
    } finally {
      loading.value = false;
    }
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
  const settings = computed<AppSettings>(
    () =>
      snapshot.value?.settings ?? {
        theme: "dark",
        locale: "zh",
        lastView: "identities",
        layout: "2x2",
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

  async function saveEnvironment(draft: EnvironmentDraft) {
    return run("environment", () => window.ensemble.saveEnvironment(draft), "环境已保存");
  }

  async function deleteEnvironment(id: string) {
    return run("environment", () => window.ensemble.deleteEnvironment(id));
  }

  async function saveIdentity(draft: IdentityDraft) {
    return run("identity", () => window.ensemble.saveIdentity(draft), "身份已保存");
  }

  async function deleteIdentity(id: string) {
    return run("identity", () => window.ensemble.deleteIdentity(id));
  }

  async function saveScene(draft: SceneDraft) {
    return run("scene", () => window.ensemble.saveScene(draft), "场景已保存");
  }

  async function deleteScene(id: string) {
    return run("scene", () => window.ensemble.deleteScene(id));
  }

  async function scanEngines() {
    return run("scan", async () => {
      const engines = await window.ensemble.scanEngines();
      notify(`扫描完成，发现 ${engines.length} 个浏览器`, "success");
      return engines;
    });
  }

  async function addManualEngine() {
    return run("scan", async () => {
      const engines = await window.ensemble.addManualEngine();
      notify("已添加手动指定的浏览器", "success");
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
    return run("launch", () => window.ensemble.launchScene(sceneId), "场景已启动");
  }

  async function launchCleanSession() {
    const envId = activeEnvironment.value?.id;
    if (!envId) {
      notify("请先创建环境", "error");
      return;
    }
    return run("launch", async () => {
      const result = await window.ensemble.launchCleanSession(envId);
      notify("已打开干净会话", "success");
      return result;
    });
  }

  async function stopInstance(id: string) {
    return run("stop", () => window.ensemble.stopInstance(id));
  }

  async function stopAll() {
    return run("stop", async () => {
      await window.ensemble.stopAll();
      notify("已关闭全部实例", "success");
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
      notify(result.detail ?? "已填充", "success");
      return result;
    });
  }

  async function setPassword(owner: PasswordOwner, password: string) {
    return run("password", () => window.ensemble.setPassword(owner, password), "密码已保存");
  }

  async function clearPassword(owner: PasswordOwner) {
    return run("password", () => window.ensemble.clearPassword(owner));
  }

  async function copyPassword(owner: PasswordOwner) {
    const copied = await window.ensemble.copyPassword(owner);
    notify(copied ? "已复制，30 秒后清除剪贴板" : "没有可复制的密码", copied ? "success" : "error");
  }

  async function saveSettings(patch: SettingsPatch) {
    return run("settings", () => window.ensemble.saveSettings(patch));
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
    saveSettings,
    setLayout,
  };
});
