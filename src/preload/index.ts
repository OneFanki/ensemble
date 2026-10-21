import { contextBridge, ipcRenderer } from "electron";
import { IPC, type EnsembleApi } from "@shared/ipc";
import type { AutoFillReport, FocusLabelPayload, SceneRestoreOutcome, WorkspaceSnapshot } from "@shared/types";
import type { UpdateCheckResult, UpdateProgress } from "@shared/update";

const api: EnsembleApi = {
  getWorkspace: () => ipcRenderer.invoke(IPC.workspaceGet),
  onWorkspaceChanged: (listener: (snapshot: WorkspaceSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: WorkspaceSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.workspaceChanged, handler);
    return () => ipcRenderer.removeListener(IPC.workspaceChanged, handler);
  },

  scanEngines: () => ipcRenderer.invoke(IPC.enginesScan),
  addManualEngine: () => ipcRenderer.invoke(IPC.enginesAddManual),
  removeManualEngine: (exePath) => ipcRenderer.invoke(IPC.enginesRemoveManual, exePath),

  saveEnvironment: (draft) => ipcRenderer.invoke(IPC.environmentSave, draft),
  deleteEnvironment: (id) => ipcRenderer.invoke(IPC.environmentDelete, id),
  saveIdentity: (draft) => ipcRenderer.invoke(IPC.identitySave, draft),
  deleteIdentity: (id) => ipcRenderer.invoke(IPC.identityDelete, id),
  rebuildIdentityProfile: (id) => ipcRenderer.invoke(IPC.identityRebuildProfile, id),
  saveScene: (draft) => ipcRenderer.invoke(IPC.sceneSave, draft),
  deleteScene: (id) => ipcRenderer.invoke(IPC.sceneDelete, id),
  setSceneLayout: (sceneId, layoutId) => ipcRenderer.invoke(IPC.sceneSetLayout, sceneId, layoutId),
  setSceneSlotAssignments: (sceneId, assignments) =>
    ipcRenderer.invoke(IPC.sceneSetSlots, sceneId, assignments),
  retileScene: (sceneId) => ipcRenderer.invoke(IPC.sceneRetile, sceneId),
  saveLayoutPreset: (draft) => ipcRenderer.invoke(IPC.layoutPresetSave, draft),
  deleteLayoutPreset: (id) => ipcRenderer.invoke(IPC.layoutPresetDelete, id),
  exportWorkspace: (options) => ipcRenderer.invoke(IPC.dataExport, options),
  pickImport: () => ipcRenderer.invoke(IPC.dataImportPick),
  applyImport: (passphrase) => ipcRenderer.invoke(IPC.dataImportApply, passphrase),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),

  mcpStatus: () => ipcRenderer.invoke(IPC.mcpInfo),
  updateMcp: (patch) => ipcRenderer.invoke(IPC.mcpUpdate, patch),

  setPassword: (owner, password) => ipcRenderer.invoke(IPC.credentialsSet, owner, password),
  clearPassword: (owner) => ipcRenderer.invoke(IPC.credentialsClear, owner),
  copyPassword: (owner) => ipcRenderer.invoke(IPC.credentialsCopy, owner),
  unlockVault: (password) => ipcRenderer.invoke(IPC.credentialsUnlock, password),
  lockVault: () => ipcRenderer.invoke(IPC.credentialsLock),
  setMasterPassword: (password) => ipcRenderer.invoke(IPC.credentialsSetMaster, password),
  removeMasterPassword: () => ipcRenderer.invoke(IPC.credentialsRemoveMaster),
  changeMasterPassword: (current, next) =>
    ipcRenderer.invoke(IPC.credentialsChangeMaster, current, next),

  launchIdentity: (identityId, pathOverride) =>
    ipcRenderer.invoke(IPC.instanceLaunch, identityId, pathOverride),
  launchIdentities: (identityIds) => ipcRenderer.invoke(IPC.instanceLaunchBatch, identityIds),
  launchScene: (sceneId) => ipcRenderer.invoke(IPC.instanceLaunchScene, sceneId),
  launchSceneMember: (sceneId, identityId) =>
    ipcRenderer.invoke(IPC.instanceLaunchSceneMember, sceneId, identityId),
  launchCleanSession: (environmentId) => ipcRenderer.invoke(IPC.instanceClean, environmentId),
  stopInstance: (id) => ipcRenderer.invoke(IPC.instanceStop, id),
  stopAll: () => ipcRenderer.invoke(IPC.instanceStopAll),
  stopScene: (sceneId) => ipcRenderer.invoke(IPC.instanceStopScene, sceneId),
  focusInstance: (id) => ipcRenderer.invoke(IPC.instanceFocus, id),
  onActiveInstance: (listener: (instanceId: string | null) => void) => {
    const handler = (_event: unknown, instanceId: string | null) => listener(instanceId);
    ipcRenderer.on(IPC.instanceActive, handler);
    return () => ipcRenderer.removeListener(IPC.instanceActive, handler);
  },
  onFocusLabelShow: (listener: (payload: FocusLabelPayload) => void) => {
    const handler = (_event: unknown, payload: FocusLabelPayload) => listener(payload);
    ipcRenderer.on(IPC.focusLabelShow, handler);
    return () => ipcRenderer.removeListener(IPC.focusLabelShow, handler);
  },
  checkAuth: (identityId) => ipcRenderer.invoke(IPC.authCheck, identityId),
  checkAllAuth: (environmentId) => ipcRenderer.invoke(IPC.authCheckAll, environmentId),
  reloginExpired: (environmentId) => ipcRenderer.invoke(IPC.authReloginExpired, environmentId),
  fillLogin: (identityId) => ipcRenderer.invoke(IPC.authFill, identityId),
  onAutoFilled: (listener: (report: AutoFillReport) => void) => {
    const handler = (_event: unknown, report: AutoFillReport) => listener(report);
    ipcRenderer.on(IPC.authAutoFilled, handler);
    return () => ipcRenderer.removeListener(IPC.authAutoFilled, handler);
  },
  onSceneRestored: (listener: (outcome: SceneRestoreOutcome) => void) => {
    const handler = (_event: unknown, outcome: SceneRestoreOutcome) => listener(outcome);
    ipcRenderer.on(IPC.sceneRestored, handler);
    return () => ipcRenderer.removeListener(IPC.sceneRestored, handler);
  },

  resizeOverlay: (size) => ipcRenderer.invoke(IPC.overlayResize, size),
  setOverlayCompact: (compact) => ipcRenderer.invoke(IPC.overlayCompact, compact),
  moveOverlay: (position) => ipcRenderer.invoke(IPC.overlayMove, position),
  hideOverlay: () => ipcRenderer.invoke(IPC.overlayHide),

  saveAppSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),
  setTheme: (theme) => ipcRenderer.invoke(IPC.appSetTheme, theme),
  quitApp: () => ipcRenderer.invoke(IPC.appQuit),
  openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
  checkUpdate: () => ipcRenderer.invoke(IPC.appCheckUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC.appDownloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
  onUpdateAvailable: (listener: (result: UpdateCheckResult) => void) => {
    const handler = (_event: unknown, result: UpdateCheckResult) => listener(result);
    ipcRenderer.on(IPC.appUpdateAvailable, handler);
    return () => ipcRenderer.removeListener(IPC.appUpdateAvailable, handler);
  },
  onUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
    const handler = (_event: unknown, progress: UpdateProgress) => listener(progress);
    ipcRenderer.on(IPC.appUpdateProgress, handler);
    return () => ipcRenderer.removeListener(IPC.appUpdateProgress, handler);
  },

  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),
  showWindow: () => ipcRenderer.invoke(IPC.windowShow),
};

contextBridge.exposeInMainWorld("ensemble", api);
