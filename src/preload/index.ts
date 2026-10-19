import { contextBridge, ipcRenderer } from "electron";
import { IPC, type EnsembleApi } from "@shared/ipc";
import type { WorkspaceSnapshot } from "@shared/types";

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
  saveSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),

  setPassword: (owner, password) => ipcRenderer.invoke(IPC.credentialsSet, owner, password),
  clearPassword: (owner) => ipcRenderer.invoke(IPC.credentialsClear, owner),
  copyPassword: (owner) => ipcRenderer.invoke(IPC.credentialsCopy, owner),

  launchIdentity: (identityId, pathOverride) =>
    ipcRenderer.invoke(IPC.instanceLaunch, identityId, pathOverride),
  launchScene: (sceneId) => ipcRenderer.invoke(IPC.instanceLaunchScene, sceneId),
  launchCleanSession: (environmentId) => ipcRenderer.invoke(IPC.instanceClean, environmentId),
  stopInstance: (id) => ipcRenderer.invoke(IPC.instanceStop, id),
  stopAll: () => ipcRenderer.invoke(IPC.instanceStopAll),
  checkAuth: (identityId) => ipcRenderer.invoke(IPC.authCheck, identityId),
  fillLogin: (identityId) => ipcRenderer.invoke(IPC.authFill, identityId),

  saveAppSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),
  setTheme: (theme) => ipcRenderer.invoke(IPC.appSetTheme, theme),

  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),
};

contextBridge.exposeInMainWorld("ensemble", api);
