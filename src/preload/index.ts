import type { EmbeddedState } from "@shared/embedded";
import { type EnsembleApi, IPC } from "@shared/ipc";
import type {
  AiPageAction,
  AutoFillReport,
  FocusLabelPayload,
  LoginCaptureNotice,
  McpStatus,
  ViewRestoreOutcome,
  WorkspaceSnapshot,
} from "@shared/types";
import type { UpdateCheckResult, UpdateProgress } from "@shared/update";
import { contextBridge, ipcRenderer } from "electron";

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

  saveSite: (draft) => ipcRenderer.invoke(IPC.siteSave, draft),
  deleteSite: (id) => ipcRenderer.invoke(IPC.siteDelete, id),
  saveTag: (draft) => ipcRenderer.invoke(IPC.tagSave, draft),
  deleteTag: (id) => ipcRenderer.invoke(IPC.tagDelete, id),
  saveIdentity: (draft) => ipcRenderer.invoke(IPC.identitySave, draft),
  deleteIdentity: (id) => ipcRenderer.invoke(IPC.identityDelete, id),
  rebuildIdentityProfile: (id) => ipcRenderer.invoke(IPC.identityRebuildProfile, id),
  detachReference: (id) => ipcRenderer.invoke(IPC.identityDetachReference, id),
  saveView: (draft) => ipcRenderer.invoke(IPC.viewSave, draft),
  deleteView: (id) => ipcRenderer.invoke(IPC.viewDelete, id),
  moveView: (id, toIndex) => ipcRenderer.invoke(IPC.viewMove, id, toIndex),
  setViewLayout: (viewId, layoutId) => ipcRenderer.invoke(IPC.viewSetLayout, viewId, layoutId),
  setViewSlotAssignments: (viewId, assignments) =>
    ipcRenderer.invoke(IPC.viewSetSlots, viewId, assignments),
  retileView: (viewId) => ipcRenderer.invoke(IPC.viewRetile, viewId),
  copyViewToSite: (viewId, targetSiteId) =>
    ipcRenderer.invoke(IPC.viewCopyToSite, viewId, targetSiteId),
  saveFlow: (draft) => ipcRenderer.invoke(IPC.flowSave, draft),
  deleteFlow: (id) => ipcRenderer.invoke(IPC.flowDelete, id),
  runFlow: (input) => ipcRenderer.invoke(IPC.flowRun, input),
  saveBookmark: (draft) => ipcRenderer.invoke(IPC.bookmarkSave, draft),
  setBookmarkFavicon: (id, favicon) => ipcRenderer.invoke(IPC.bookmarkFavicon, id, favicon),
  deleteBookmark: (id) => ipcRenderer.invoke(IPC.bookmarkDelete, id),
  moveBookmark: (id, toIndex) => ipcRenderer.invoke(IPC.bookmarkMove, id, toIndex),
  acceptSiteOrigin: (siteId) => ipcRenderer.invoke(IPC.siteAcceptOrigin, siteId),
  takeOriginNotice: () => ipcRenderer.invoke(IPC.siteOriginNotice),
  saveLayoutPreset: (draft) => ipcRenderer.invoke(IPC.layoutPresetSave, draft),
  deleteLayoutPreset: (id) => ipcRenderer.invoke(IPC.layoutPresetDelete, id),
  exportWorkspace: (options) => ipcRenderer.invoke(IPC.dataExport, options),
  pickImport: () => ipcRenderer.invoke(IPC.dataImportPick),
  applyImport: (passphrase) => ipcRenderer.invoke(IPC.dataImportApply, passphrase),
  exportAccounts: (options) => ipcRenderer.invoke(IPC.accountsExport, options),
  pickAccountsImport: () => ipcRenderer.invoke(IPC.accountsImportPick),
  applyAccountsImport: (passphrase) => ipcRenderer.invoke(IPC.accountsImportApply, passphrase),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),

  mcpStatus: () => ipcRenderer.invoke(IPC.mcpInfo),
  updateMcp: (patch) => ipcRenderer.invoke(IPC.mcpUpdate, patch),
  onMcpChanged: (listener) => {
    const handler = (_event: unknown, status: McpStatus) => listener(status);
    ipcRenderer.on(IPC.mcpChanged, handler);
    return () => ipcRenderer.removeListener(IPC.mcpChanged, handler);
  },
  onAiPageAction: (listener) => {
    const handler = (_event: unknown, action: AiPageAction) => listener(action);
    ipcRenderer.on(IPC.aiPageAction, handler);
    return () => ipcRenderer.removeListener(IPC.aiPageAction, handler);
  },

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
  launchView: (viewId) => ipcRenderer.invoke(IPC.instanceLaunchView, viewId),
  launchViewMember: (viewId, identityId) =>
    ipcRenderer.invoke(IPC.instanceLaunchViewMember, viewId, identityId),
  launchCleanSession: (siteId) => ipcRenderer.invoke(IPC.instanceClean, siteId),
  stopInstance: (id) => ipcRenderer.invoke(IPC.instanceStop, id),
  stopAll: () => ipcRenderer.invoke(IPC.instanceStopAll),
  stopView: (viewId) => ipcRenderer.invoke(IPC.instanceStopView, viewId),
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
  checkAllAuth: (siteId) => ipcRenderer.invoke(IPC.authCheckAll, siteId),
  reloginExpired: (siteId) => ipcRenderer.invoke(IPC.authReloginExpired, siteId),
  fillLogin: (identityId) => ipcRenderer.invoke(IPC.authFill, identityId),
  onAutoFilled: (listener: (report: AutoFillReport) => void) => {
    const handler = (_event: unknown, report: AutoFillReport) => listener(report);
    ipcRenderer.on(IPC.authAutoFilled, handler);
    return () => ipcRenderer.removeListener(IPC.authAutoFilled, handler);
  },
  onViewRestored: (listener: (outcome: ViewRestoreOutcome) => void) => {
    const handler = (_event: unknown, outcome: ViewRestoreOutcome) => listener(outcome);
    ipcRenderer.on(IPC.viewRestored, handler);
    return () => ipcRenderer.removeListener(IPC.viewRestored, handler);
  },

  resizeOverlay: (size) => ipcRenderer.invoke(IPC.overlayResize, size),
  setOverlayCompact: (compact) => ipcRenderer.invoke(IPC.overlayCompact, compact),
  moveOverlay: (position) => ipcRenderer.invoke(IPC.overlayMove, position),
  hideOverlay: () => ipcRenderer.invoke(IPC.overlayHide),

  getEmbeddedState: () => ipcRenderer.invoke(IPC.embeddedStateGet),
  onEmbeddedState: (listener: (state: EmbeddedState) => void) => {
    const handler = (_event: unknown, state: EmbeddedState) => listener(state);
    ipcRenderer.on(IPC.embeddedState, handler);
    return () => ipcRenderer.removeListener(IPC.embeddedState, handler);
  },
  onEmbeddedPage: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.embeddedPage, handler);
    return () => ipcRenderer.removeListener(IPC.embeddedPage, handler);
  },
  setEmbeddedStage: (stage) => {
    ipcRenderer.send(IPC.embeddedStage, stage);
  },
  openEmbeddedTab: (input) => ipcRenderer.invoke(IPC.embeddedOpen, input),
  openEmbeddedTabInView: (viewId) => ipcRenderer.invoke(IPC.embeddedOpenInView, viewId),
  openEmbeddedTabInSlot: (viewId, slotIndex) =>
    ipcRenderer.invoke(IPC.embeddedOpenInSlot, viewId, slotIndex),
  openEmbeddedTabInInstance: (instanceId) =>
    ipcRenderer.invoke(IPC.embeddedOpenInInstance, instanceId),
  duplicateEmbeddedTab: (tabId) => ipcRenderer.invoke(IPC.embeddedDuplicate, tabId),
  closeOtherEmbeddedTabs: (tabId) => ipcRenderer.invoke(IPC.embeddedCloseOthers, tabId),
  openEmbeddedIdentity: (identityId) => ipcRenderer.invoke(IPC.embeddedOpenIdentity, identityId),
  openEmbeddedView: (viewId) => ipcRenderer.invoke(IPC.embeddedOpenView, viewId),
  onLoginCaptured: (listener: (notice: LoginCaptureNotice) => void) => {
    const handler = (_event: unknown, notice: LoginCaptureNotice) => listener(notice);
    ipcRenderer.on(IPC.embeddedLoginCaptured, handler);
    return () => ipcRenderer.removeListener(IPC.embeddedLoginCaptured, handler);
  },
  dismissLoginCapture: (token) => ipcRenderer.invoke(IPC.embeddedLoginDismiss, token),
  closeEmbeddedTab: (tabId) => ipcRenderer.invoke(IPC.embeddedClose, tabId),
  activateEmbeddedTab: (tabId) => ipcRenderer.invoke(IPC.embeddedActivate, tabId),
  navigateEmbeddedTab: (tabId, url) => ipcRenderer.invoke(IPC.embeddedNavigate, tabId, url),
  embeddedBack: (tabId) => ipcRenderer.invoke(IPC.embeddedBack, tabId),
  embeddedForward: (tabId) => ipcRenderer.invoke(IPC.embeddedForward, tabId),
  reloadEmbeddedTab: (tabId) => ipcRenderer.invoke(IPC.embeddedReload, tabId),
  activateEmbeddedView: (viewId) => ipcRenderer.invoke(IPC.embeddedViewActivate, viewId),
  createEmbeddedView: (input) => ipcRenderer.invoke(IPC.embeddedViewCreate, input),
  setEmbeddedViewLayout: (viewId, layoutId) =>
    ipcRenderer.invoke(IPC.embeddedViewLayout, viewId, layoutId),
  groupLooseTabs: (layoutId) => ipcRenderer.invoke(IPC.embeddedGroupLoose, layoutId),
  setEmbeddedViewSlots: (viewId, rects) => ipcRenderer.invoke(IPC.embeddedViewSlots, viewId, rects),
  pinEmbeddedTab: (viewId, slotIndex, tabId) =>
    ipcRenderer.invoke(IPC.embeddedViewPin, viewId, slotIndex, tabId),
  renameEmbeddedView: (viewId, name) => ipcRenderer.invoke(IPC.embeddedViewRename, viewId, name),
  colorEmbeddedView: (viewId, color) => ipcRenderer.invoke(IPC.embeddedViewColor, viewId, color),
  collapseEmbeddedView: (viewId, collapsed) =>
    ipcRenderer.invoke(IPC.embeddedViewCollapse, viewId, collapsed),
  closeEmbeddedView: (viewId, mode) => ipcRenderer.invoke(IPC.embeddedViewClose, viewId, mode),
  dropEmbeddedTab: (tabId, target) => ipcRenderer.invoke(IPC.embeddedDropTab, tabId, target),
  fillEmbeddedLogin: (tabId) => ipcRenderer.invoke(IPC.embeddedFill, tabId),
  openEmbeddedDevTools: (tabId, mode) => ipcRenderer.invoke(IPC.embeddedDevTools, tabId, mode),
  closeEmbeddedDevTools: (tabId) => ipcRenderer.invoke(IPC.embeddedDevToolsClose, tabId),
  zoomEmbeddedTab: (tabId, direction) => ipcRenderer.invoke(IPC.embeddedZoom, tabId, direction),
  findInEmbeddedTab: (tabId, text, options) =>
    ipcRenderer.invoke(IPC.embeddedFind, tabId, text, options),
  stopEmbeddedFind: (tabId) => ipcRenderer.invoke(IPC.embeddedStopFind, tabId),
  freezeEmbedded: () => ipcRenderer.invoke(IPC.embeddedFreeze),

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
