import type {
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  Engine,
  SiteDraft,
  SiteTagDraft,
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
  SlotRect,
  ViewCopyResult,
  ViewDraft,
  ViewRestoreOutcome,
  SettingsPatch,
  WorkspaceSnapshot,
  OriginChangedNotice,
} from "./types";
import type { ExportCounts, ImportPreview, ImportResult } from "./transfer";
import type { UpdateCheckResult, UpdateProgress } from "./update";
import type {
  EmbeddedDropTarget,
  EmbeddedState,
  EmbeddedTab,
  FrozenSlot,
  StageRect,
} from "./embedded";

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
  siteSave: "site:save",
  siteDelete: "site:delete",
  /** Creates or renames a display-only site tag. */
  siteTagSave: "site-tag:save",
  /** Deletes a tag and unlinks it from every site; sites themselves stay. */
  siteTagDelete: "site-tag:delete",
  identitySave: "identity:save",
  identityDelete: "identity:delete",
  identityRebuildProfile: "identity:rebuild-profile",
  /** Detaches a credential reference into an independent copy. */
  identityDetachReference: "identity:detach-reference",
  viewSave: "view:save",
  viewDelete: "view:delete",
  viewSetLayout: "view:set-layout",
  viewSetSlots: "view:set-slots",
  viewRetile: "view:retile",
  /** Copies a view to another site, resolving members by username. */
  viewCopyToSite: "view:copy-to-site",
  /** Accepts a changed site address so credential filling may proceed again. */
  siteAcceptOrigin: "site:accept-origin",
  /** Reads the address-change notice left by the last blocked fill. */
  siteOriginNotice: "site:origin-notice",
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
  instanceLaunchView: "instance:launch-view",
  instanceLaunchViewMember: "instance:launch-view-member",
  instanceClean: "instance:clean",
  instanceStop: "instance:stop",
  instanceStopAll: "instance:stop-all",
  instanceStopView: "instance:stop-view",
  instanceFocus: "instance:focus",
  instanceActive: "instance:active",
  focusLabelShow: "focus-label:show",
  authCheck: "auth:check",
  authCheckAll: "auth:check-all",
  authReloginExpired: "auth:relogin-expired",
  authFill: "auth:fill",
  authAutoFilled: "auth:auto-filled",
  viewRestored: "view:restored",
  overlayResize: "overlay:resize",
  overlayHide: "overlay:hide",
  /** Switches the strip between its list and the floating ball. */
  overlayCompact: "overlay:compact",
  /** Moves the overlay window while the floating ball is dragged. */
  overlayMove: "overlay:move",
  /** Current tabs, views and focus of the embedded surface. */
  embeddedState: "embedded:state",
  /** One-shot read used when the renderer mounts. */
  embeddedStateGet: "embedded:state-get",
  /** Asks the renderer to switch to the browser page. */
  embeddedPage: "embedded:page",
  /** Sends the stage rectangle (content area under the chrome) to the manager. */
  embeddedStage: "embedded:stage",
  embeddedOpen: "embedded:open",
  /** Opens a blank tab directly into a named view. */
  embeddedOpenInView: "embedded:open-in-view",
  /** Opens a blank tab pinned to one slot of a view. */
  embeddedOpenInSlot: "embedded:open-in-slot",
  embeddedOpenIdentity: "embedded:open-identity",
  embeddedOpenView: "embedded:open-view",
  embeddedClose: "embedded:close",
  embeddedActivate: "embedded:activate",
  embeddedNavigate: "embedded:navigate",
  embeddedBack: "embedded:back",
  embeddedForward: "embedded:forward",
  embeddedReload: "embedded:reload",
  embeddedViewActivate: "embedded:view-activate",
  /** Creates an empty view container; views are never created by dragging. */
  embeddedViewCreate: "embedded:view-create",
  embeddedViewLayout: "embedded:view-layout",
  /** Hand-dragged slot geometry, in fractions of the stage. */
  embeddedViewSlots: "embedded:view-slots",
  embeddedViewPin: "embedded:view-pin",
  embeddedViewRename: "embedded:view-rename",
  embeddedViewColor: "embedded:view-color",
  embeddedViewCollapse: "embedded:view-collapse",
  embeddedViewClose: "embedded:view-close",
  embeddedDropTab: "embedded:drop-tab",
  /** Fills the tab's saved credentials; refuses cross-origin pages. */
  embeddedFill: "embedded:fill",
  embeddedDevTools: "embedded:devtools",
  embeddedFind: "embedded:find",
  embeddedStopFind: "embedded:stop-find",
  /** Freezes the browser stage into an image so HTML overlays can float over it. */
  embeddedFreeze: "embedded:freeze",
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

  saveSite(draft: SiteDraft): Promise<WorkspaceSnapshot>;
  deleteSite(id: string): Promise<WorkspaceSnapshot>;
  saveSiteTag(draft: SiteTagDraft): Promise<WorkspaceSnapshot>;
  deleteSiteTag(id: string): Promise<WorkspaceSnapshot>;
  saveIdentity(draft: IdentityDraft): Promise<WorkspaceSnapshot>;
  deleteIdentity(id: string): Promise<WorkspaceSnapshot>;
  /** Deletes the browser profile directory so the next launch starts signed out. */
  rebuildIdentityProfile(id: string): Promise<WorkspaceSnapshot>;
  /** Turns a credential reference into an independent copy with its own password. */
  detachReference(id: string): Promise<WorkspaceSnapshot>;
  saveView(draft: ViewDraft): Promise<WorkspaceSnapshot>;
  deleteView(id: string): Promise<WorkspaceSnapshot>;
  setViewLayout(viewId: string, layoutId: LayoutId): Promise<WorkspaceSnapshot>;
  setViewSlotAssignments(
    viewId: string,
    assignments: Record<string, number>,
  ): Promise<WorkspaceSnapshot>;
  /** Repositions the windows of one view after its slots changed. */
  retileView(viewId: string): Promise<void>;
  /** Copies a view to another site; members are matched by username. */
  copyViewToSite(viewId: string, targetSiteId: string): Promise<ViewCopyResult>;
  /** Records the site's current address as trusted. */
  acceptSiteOrigin(siteId: string): Promise<void>;
  /** Takes the pending address-change notice, if a fill was blocked by one. */
  takeOriginNotice(): Promise<OriginChangedNotice | undefined>;
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
  launchView(viewId: string): Promise<LaunchResult>;
  launchViewMember(viewId: string, identityId: string): Promise<LaunchResult>;
  /** Without an siteId this opens a blank tab outside any site. */
  launchCleanSession(siteId?: string): Promise<LaunchResult>;
  stopInstance(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Stops only the windows belonging to one view. */
  stopView(viewId: string): Promise<void>;
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
  /** Runs the login check for every identity of one site (or all). */
  checkAllAuth(siteId?: string): Promise<AuthBatchResult>;
  /** Opens the login page and fills credentials for every expired identity. */
  reloginExpired(siteId?: string): Promise<ReloginBatchResult>;
  fillLogin(identityId: string): Promise<AuthCheckResult>;
  /** Fires when a launch triggers a best-effort credential fill. */
  onAutoFilled(listener: (report: AutoFillReport) => void): () => void;
  /** Fires once at startup when the last view was restored (or failed). */
  onViewRestored(listener: (outcome: ViewRestoreOutcome) => void): () => void;

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

  /** Raises the main window and switches it to the browser page. */
  /** Current surface state; also broadcast on every change. */
  getEmbeddedState(): Promise<EmbeddedState>;
  onEmbeddedState(listener: (state: EmbeddedState) => void): () => void;
  /** Fires when the main process wants the browser page brought forward. */
  onEmbeddedPage(listener: () => void): () => void;
  /** Reports where the native views may paint, in content-area pixels. */
  setEmbeddedStage(stage: StageRect | null): void;
  /** Opens a blank tab; optionally bound to an identity for its partition. */
  openEmbeddedTab(input: {
    url?: string;
    identityId?: string;
    siteId?: string;
    label?: string;
    color?: string;
    /**
     * Target container. Omitted means "the view on stage, if any"; `null` asks
     * for a loose tab explicitly, which the dock's "Tabs" block needs.
     */
    viewId?: string | null;
  }): Promise<EmbeddedTab>;
  /** Opens a blank tab into a specific view and returns the new state. */
  openEmbeddedTabInView(viewId: string): Promise<EmbeddedState>;
  /** Opens a blank tab and pins it to `slotIndex`, then focuses it. */
  openEmbeddedTabInSlot(viewId: string, slotIndex: number): Promise<EmbeddedState>;
  /** Opens an identity's start page as a loose tab. */
  openEmbeddedIdentity(identityId: string): Promise<EmbeddedState>;
  /** Opens (or merges into) the container of a saved view. */
  openEmbeddedView(viewId: string): Promise<EmbeddedState>;
  closeEmbeddedTab(tabId: string): Promise<EmbeddedState>;
  activateEmbeddedTab(tabId: string): Promise<EmbeddedState>;
  navigateEmbeddedTab(tabId: string, url: string): Promise<EmbeddedTab>;
  embeddedBack(tabId: string): Promise<void>;
  embeddedForward(tabId: string): Promise<void>;
  reloadEmbeddedTab(tabId: string): Promise<void>;
  /** Brings a view on stage; null returns to the loose tab list. */
  activateEmbeddedView(viewId: string | null): Promise<EmbeddedState>;
  /** Creates an empty view and puts it on stage. */
  createEmbeddedView(input: { name?: string; layoutId?: LayoutId }): Promise<EmbeddedState>;
  setEmbeddedViewLayout(viewId: string, layoutId: LayoutId): Promise<EmbeddedState>;
  /** Applies slot geometry dragged by hand (fractions of the stage). */
  setEmbeddedViewSlots(viewId: string, rects: SlotRect[]): Promise<EmbeddedState>;
  /** Binds a tab to one slot of a view; null empties the slot. */
  pinEmbeddedTab(
    viewId: string,
    slotIndex: number,
    tabId: string | null,
  ): Promise<EmbeddedState>;
  renameEmbeddedView(viewId: string, name: string): Promise<EmbeddedState>;
  colorEmbeddedView(viewId: string, color: string | null): Promise<EmbeddedState>;
  collapseEmbeddedView(viewId: string, collapsed: boolean): Promise<EmbeddedState>;
  /** Closes a view; "opened" leaves hand-made and AI tabs running. */
  closeEmbeddedView(viewId: string, mode: "all" | "opened"): Promise<EmbeddedState>;
  dropEmbeddedTab(tabId: string, target: EmbeddedDropTarget): Promise<EmbeddedState>;
  fillEmbeddedLogin(tabId: string): Promise<{
    ok: boolean;
    reason?: string;
    submitted?: boolean;
    missingFields?: string[];
  }>;
  openEmbeddedDevTools(tabId: string): Promise<void>;
  findInEmbeddedTab(
    tabId: string,
    text: string,
    options?: { forward?: boolean; findNext?: boolean },
  ): Promise<{ matches: number; activeMatch: number }>;
  stopEmbeddedFind(tabId: string): Promise<void>;
  /**
   * Captures every page on stage as positioned images so a rich HTML overlay can
   * float above the browser. Native views paint over HTML, so the alternative is
   * hiding pages.
   */
  freezeEmbedded(): Promise<FrozenSlot[]>;

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
