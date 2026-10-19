import { contextBridge, ipcRenderer } from "electron";
import { IPC, type EnsembleApi } from "@shared/ipc";
import type { AutoFillReport, WorkspaceSnapshot } from "@shared/types";

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
  launchScene: (sceneId) => ipcRenderer.invoke(IPC.instanceLaunchScene, sceneId),
  launchSceneMember: (sceneId, identityId) =>
    ipcRenderer.invoke(IPC.instanceLaunchSceneMember, sceneId, identityId),
  launchCleanSession: (environmentId) => ipcRenderer.invoke(IPC.instanceClean, environmentId),
  stopInstance: (id) => ipcRenderer.invoke(IPC.instanceStop, id),
  stopAll: () => ipcRenderer.invoke(IPC.instanceStopAll),
  checkAuth: (identityId) => ipcRenderer.invoke(IPC.authCheck, identityId),
  fillLogin: (identityId) => ipcRenderer.invoke(IPC.authFill, identityId),
  onAutoFilled: (listener: (report: AutoFillReport) => void) => {
    const handler = (_event: unknown, report: AutoFillReport) => listener(report);
    ipcRenderer.on(IPC.authAutoFilled, handler);
    return () => ipcRenderer.removeListener(IPC.authAutoFilled, handler);
  },

  saveAppSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),
  setTheme: (theme) => ipcRenderer.invoke(IPC.appSetTheme, theme),
  quitApp: () => ipcRenderer.invoke(IPC.appQuit),

  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),
  showWindow: () => ipcRenderer.invoke(IPC.windowShow),
};

contextBridge.exposeInMainWorld("ensemble", api);
