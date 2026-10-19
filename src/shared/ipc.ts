import type {
  AppSettings,
  AuthCheckResult,
  AutoFillReport,
  Engine,
  EnvironmentDraft,
  IdentityDraft,
  LaunchResult,
  PasswordOwner,
  SceneDraft,
  SettingsPatch,
  WorkspaceSnapshot,
} from "./types";

export const IPC = {
  workspaceGet: "workspace:get",
  workspaceChanged: "workspace:changed",
  enginesScan: "engines:scan",
  enginesAddManual: "engines:add-manual",
  enginesRemoveManual: "engines:remove-manual",
  environmentSave: "environment:save",
  environmentDelete: "environment:delete",
  identitySave: "identity:save",
  identityDelete: "identity:delete",
  identityRebuildProfile: "identity:rebuild-profile",
  sceneSave: "scene:save",
  sceneDelete: "scene:delete",
  credentialsSet: "credentials:set",
  credentialsClear: "credentials:clear",
  credentialsCopy: "credentials:copy",
  credentialsUnlock: "credentials:unlock",
  credentialsLock: "credentials:lock",
  credentialsSetMaster: "credentials:set-master",
  credentialsRemoveMaster: "credentials:remove-master",
  credentialsChangeMaster: "credentials:change-master",
  instanceLaunch: "instance:launch",
  instanceLaunchScene: "instance:launch-scene",
  instanceClean: "instance:clean",
  instanceStop: "instance:stop",
  instanceStopAll: "instance:stop-all",
  authCheck: "auth:check",
  authFill: "auth:fill",
  authAutoFilled: "auth:auto-filled",
  settingsSave: "settings:save",
  appSetTheme: "app:set-theme",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
} as const;

export interface EnsembleApi {
  getWorkspace(): Promise<WorkspaceSnapshot>;
  onWorkspaceChanged(listener: (snapshot: WorkspaceSnapshot) => void): () => void;

  scanEngines(): Promise<Engine[]>;
  addManualEngine(): Promise<Engine[]>;
  removeManualEngine(exePath: string): Promise<Engine[]>;

  saveEnvironment(draft: EnvironmentDraft): Promise<WorkspaceSnapshot>;
  deleteEnvironment(id: string): Promise<WorkspaceSnapshot>;
  saveIdentity(draft: IdentityDraft): Promise<WorkspaceSnapshot>;
  deleteIdentity(id: string): Promise<WorkspaceSnapshot>;
  /** Deletes the browser profile directory so the next launch starts signed out. */
  rebuildIdentityProfile(id: string): Promise<WorkspaceSnapshot>;
  saveScene(draft: SceneDraft): Promise<WorkspaceSnapshot>;
  deleteScene(id: string): Promise<WorkspaceSnapshot>;
  saveSettings(patch: SettingsPatch): Promise<WorkspaceSnapshot>;

  setPassword(owner: PasswordOwner, password: string): Promise<WorkspaceSnapshot>;
  clearPassword(owner: PasswordOwner): Promise<WorkspaceSnapshot>;
  copyPassword(owner: PasswordOwner): Promise<boolean>;
  /** Returns false when the master password is wrong. */
  unlockVault(password: string): Promise<boolean>;
  lockVault(): Promise<WorkspaceSnapshot>;
  setMasterPassword(password: string): Promise<WorkspaceSnapshot>;
  removeMasterPassword(): Promise<WorkspaceSnapshot>;
  changeMasterPassword(current: string, next: string): Promise<boolean>;

  launchIdentity(identityId: string, pathOverride?: string): Promise<LaunchResult>;
  launchScene(sceneId: string): Promise<LaunchResult>;
  launchCleanSession(environmentId: string): Promise<LaunchResult>;
  stopInstance(id: string): Promise<void>;
  stopAll(): Promise<void>;
  checkAuth(identityId: string): Promise<AuthCheckResult>;
  fillLogin(identityId: string): Promise<AuthCheckResult>;
  /** Fires when a launch triggers a best-effort credential fill. */
  onAutoFilled(listener: (report: AutoFillReport) => void): () => void;

  saveAppSettings(patch: SettingsPatch): Promise<AppSettings>;
  setTheme(theme: AppSettings["theme"]): Promise<void>;

  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
}
