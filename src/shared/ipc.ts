import type {
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  Engine,
  EnvironmentDraft,
  FocusLabelPayload,
  IdentityDraft,
  LaunchResult,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  McpPatch,
  McpStatus,
  PasswordOwner,
  ReloginBatchResult,
  SceneDraft,
  SceneRestoreOutcome,
  SettingsPatch,
  WorkspaceSnapshot,
} from "./types";
import type { ExportCounts, ImportPreview, ImportResult } from "./transfer";
import type { UpdateCheckResult, UpdateProgress } from "./update";

export interface ExportOutcome {
  canceled: boolean;
  path?: string;
  counts?: ExportCounts;
  secretsIncluded?: boolean;
}

export interface ImportPickOutcome {
  canceled: boolean;
  path?: string;
  preview?: ImportPreview;
}

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
  sceneSetLayout: "scene:set-layout",
  sceneSetSlots: "scene:set-slots",
  sceneRetile: "scene:retile",
  layoutPresetSave: "layout:save",
  layoutPresetDelete: "layout:delete",
  dataExport: "data:export",
  dataImportPick: "data:import-pick",
  dataImportApply: "data:import-apply",
  mcpInfo: "mcp:info",
  mcpUpdate: "mcp:update",
  credentialsSet: "credentials:set",
  credentialsClear: "credentials:clear",
  credentialsCopy: "credentials:copy",
  credentialsUnlock: "credentials:unlock",
  credentialsLock: "credentials:lock",
  credentialsSetMaster: "credentials:set-master",
  credentialsRemoveMaster: "credentials:remove-master",
  credentialsChangeMaster: "credentials:change-master",
  instanceLaunch: "instance:launch",
  instanceLaunchBatch: "instance:launch-batch",
  instanceLaunchScene: "instance:launch-scene",
  instanceLaunchSceneMember: "instance:launch-scene-member",
  instanceClean: "instance:clean",
  instanceStop: "instance:stop",
  instanceStopAll: "instance:stop-all",
  instanceStopScene: "instance:stop-scene",
  instanceFocus: "instance:focus",
  instanceActive: "instance:active",
  focusLabelShow: "focus-label:show",
  authCheck: "auth:check",
  authCheckAll: "auth:check-all",
  authReloginExpired: "auth:relogin-expired",
  authFill: "auth:fill",
  authAutoFilled: "auth:auto-filled",
  sceneRestored: "scene:restored",
  overlayResize: "overlay:resize",
  overlayHide: "overlay:hide",
  /** Switches the strip between its list and the floating ball. */
  overlayCompact: "overlay:compact",
  /** Moves the overlay window while the floating ball is dragged. */
  overlayMove: "overlay:move",
  settingsSave: "settings:save",
  appSetTheme: "app:set-theme",
  appQuit: "app:quit",
  appOpenExternal: "app:open-external",
  appCheckUpdate: "app:check-update",
  /** Starts the verified download of the release found by the last check. */
  appDownloadUpdate: "app:download-update",
  /** Applies a downloaded update: quits, installs, relaunches. */
  appInstallUpdate: "app:install-update",
  /** Fires when a background check finds a newer release. */
  appUpdateAvailable: "app:update-available",
  /** Download progress for the update dialog. */
  appUpdateProgress: "app:update-progress",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowShow: "window:show",
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
  setSceneLayout(sceneId: string, layoutId: LayoutId): Promise<WorkspaceSnapshot>;
  setSceneSlotAssignments(
    sceneId: string,
    assignments: Record<string, number>,
  ): Promise<WorkspaceSnapshot>;
  /** Repositions the windows of one scene after its slots changed. */
  retileScene(sceneId: string): Promise<void>;
  /** Returns the saved preset so the caller can select it right away. */
  saveLayoutPreset(draft: LayoutPresetDraft): Promise<LayoutPreset>;
  deleteLayoutPreset(id: LayoutId): Promise<WorkspaceSnapshot>;
  /** Asks for a destination file, then writes the portable workspace there. */
  exportWorkspace(options: {
    includeSecrets: boolean;
    passphrase?: string;
  }): Promise<ExportOutcome>;
  /** Asks for a file, validates it, and keeps it pending for `applyImport`. */
  pickImport(): Promise<ImportPickOutcome>;
  applyImport(passphrase?: string): Promise<ImportResult>;
  saveSettings(patch: SettingsPatch): Promise<WorkspaceSnapshot>;

  mcpStatus(): Promise<McpStatus>;
  updateMcp(patch: McpPatch): Promise<McpStatus>;

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
  /**
   * Opens several identities at once, tiled with the default layout. This is the
   * identities page's "launch selected" action.
   */
  launchIdentities(identityIds: string[]): Promise<LaunchResult>;
  launchScene(sceneId: string): Promise<LaunchResult>;
  launchSceneMember(sceneId: string, identityId: string): Promise<LaunchResult>;
  /** Without an environmentId this opens a blank tab outside any environment. */
  launchCleanSession(environmentId?: string): Promise<LaunchResult>;
  stopInstance(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Stops only the windows belonging to one scene. */
  stopScene(sceneId: string): Promise<void>;
  /** Brings a running browser window to the front; false for external mode. */
  focusInstance(id: string): Promise<boolean>;
  /**
   * Id of the instance whose window currently owns the OS foreground, or null.
   * Follows windows the user raised by hand, not just our own clicks.
   */
  onActiveInstance(listener: (instanceId: string | null) => void): () => void;
  /** Fires when a just-raised window should flash its account label. */
  onFocusLabelShow(listener: (payload: FocusLabelPayload) => void): () => void;
  checkAuth(identityId: string): Promise<AuthCheckResult>;
  /** Runs the login check for every identity of one environment (or all). */
  checkAllAuth(environmentId?: string): Promise<AuthBatchResult>;
  /** Opens the login page and fills credentials for every expired identity. */
  reloginExpired(environmentId?: string): Promise<ReloginBatchResult>;
  fillLogin(identityId: string): Promise<AuthCheckResult>;
  /** Fires when a launch triggers a best-effort credential fill. */
  onAutoFilled(listener: (report: AutoFillReport) => void): () => void;
  /** Fires once at startup when the last scene was restored (or failed). */
  onSceneRestored(listener: (outcome: SceneRestoreOutcome) => void): () => void;

  /**
   * Resizes the running-instances overlay; the main process clamps both axes.
   * Either axis may be omitted, in which case the stored size is kept — the
   * renderer only measures height, width belongs to the user's manual resize.
   */
  resizeOverlay(size: { width?: number; height?: number }): Promise<void>;
  /** Collapses the strip into a floating ball, or expands it back. */
  setOverlayCompact(compact: boolean): Promise<void>;
  /**
   * Moves the overlay window to a screen position. `snap` docks the floating
   * ball to the nearest screen edge once the drag ends.
   */
  moveOverlay(position: { x: number; y: number; snap?: boolean }): Promise<void>;
  /** Hides the overlay and remembers the preference. */
  hideOverlay(): Promise<void>;

  saveAppSettings(patch: SettingsPatch): Promise<AppSettings>;
  setTheme(theme: AppSettings["theme"]): Promise<void>;
  /** Fully quits: stops browsers and the MCP endpoint, then exits. */
  quitApp(): Promise<void>;
  /** Opens a documentation or release URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Compares the running version with the latest GitHub release; check-only. */
  checkUpdate(): Promise<UpdateCheckResult>;
  /**
   * Downloads the installer for the release the last check found and verifies
   * its SHA-256. Resolves once the file is verified and ready to install.
   */
  downloadUpdate(): Promise<UpdateCheckResult>;
  /** Quits, installs the verified update and relaunches the new version. */
  installUpdate(): Promise<void>;
  /** Fires when a background check (not the manual button) finds a new version. */
  onUpdateAvailable(listener: (result: UpdateCheckResult) => void): () => void;
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;

  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  /** Shows the window again; used when the app is running in the tray. */
  showWindow(): Promise<void>;
}
