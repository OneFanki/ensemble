import type { BundleCounts, BundleImportResult, BundlePreview } from "./accounts-transfer";
import type {
  EmbeddedDropTarget,
  EmbeddedState,
  EmbeddedTab,
  FrozenSlot,
  StageRect,
} from "./embedded";
import type { FlowDraft, FlowRunResult } from "./flows";
import type { ExportCounts, ImportPreview, ImportResult } from "./transfer";
import type {
  AiPageAction,
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  BookmarkDraft,
  BookmarkFolderDraft,
  BookmarkImportOutcome,
  BookmarkImportSourceInfo,
  Engine,
  FocusLabelPayload,
  IdentityDraft,
  LaunchResult,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  LoginCaptureNotice,
  McpPatch,
  McpStatus,
  OriginChangedNotice,
  PasswordOwner,
  ReloginBatchResult,
  SettingsPatch,
  SiteDraft,
  SlotRect,
  TagDraft,
  ViewCopyResult,
  ViewDraft,
  ViewRestoreOutcome,
  WorkspaceSnapshot,
} from "./types";
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

/** Account bundles: a chosen subset of accounts, for sharing with a colleague. */
export interface AccountsExportOutcome {
  canceled: boolean;
  path?: string;
  counts?: BundleCounts;
  secretsIncluded?: boolean;
}

export interface AccountsImportPickOutcome {
  canceled: boolean;
  path?: string;
  preview?: BundlePreview;
}

export interface AccountsImportApplyOutcome {
  result: BundleImportResult;
  snapshot: WorkspaceSnapshot;
}

/** What a flow run reports back: which tab it drove, and how far it got. */
export interface FlowRunOutcome {
  tabId: string;
  identityId?: string;
  run: FlowRunResult;
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
  tagSave: "site-tag:save",
  /** Deletes a tag and unlinks it from every site; sites themselves stay. */
  tagDelete: "site-tag:delete",
  identitySave: "identity:save",
  identityDelete: "identity:delete",
  /** Points a batch of accounts at one site; also re-links accounts with none. */
  identityLinkSite: "identity:link-site",
  identityRebuildProfile: "identity:rebuild-profile",
  /** Detaches a credential reference into an independent copy. */
  identityDetachReference: "identity:detach-reference",
  viewSave: "view:save",
  viewDelete: "view:delete",
  viewMove: "view:move",
  viewSetLayout: "view:set-layout",
  viewSetSlots: "view:set-slots",
  viewRetile: "view:retile",
  /** Copies a view to another site, resolving members by username. */
  viewCopyToSite: "view:copy-to-site",
  flowSave: "flow:save",
  flowDelete: "flow:delete",
  /** Runs a saved flow against a tab and reports every step's outcome. */
  flowRun: "flow:run",
  /** Adds or renames a plain bookmark (a name and an address, no site). */
  bookmarkSave: "bookmark:save",
  /** Stores the icon a page already showed, so the grid needs no fetch. */
  bookmarkFavicon: "bookmark:favicon",
  bookmarkDelete: "bookmark:delete",
  /** Moves one bookmark to an explicit index and renumbers the rest. */
  bookmarkMove: "bookmark:move",
  /** Adds a bookmark folder, or renames and moves an existing one. */
  bookmarkFolderSave: "bookmark:folder-save",
  /** Deletes one folder; its contents re-parent one level up. */
  bookmarkFolderDelete: "bookmark:folder-delete",
  /** Detects importable browser bookmark profiles on this machine. */
  bookmarkImportSources: "bookmark:import-sources",
  /** Imports one detected source by id. */
  bookmarkImport: "bookmark:import",
  /** Accepts a changed site address so credential filling may proceed again. */
  siteAcceptOrigin: "site:accept-origin",
  /** Reads the address-change notice left by the last blocked fill. */
  siteOriginNotice: "site:origin-notice",
  layoutPresetSave: "layout:save",
  layoutPresetDelete: "layout:delete",
  dataExport: "data:export",
  dataImportPick: "data:import-pick",
  dataImportApply: "data:import-apply",
  accountsExport: "accounts:export",
  accountsImportPick: "accounts:import-pick",
  accountsImportApply: "accounts:import-apply",
  mcpInfo: "mcp:info",
  mcpUpdate: "mcp:update",
  mcpChanged: "mcp:changed",
  /** Main → renderer: an AI client acted on a page, with its origin. */
  aiPageAction: "ai:page-action",
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
  /** Main → renderer: a login form was submitted in an embedded page. */
  embeddedLoginCaptured: "embedded:login-captured",
  /** Renderer → main: forget a pending capture the user declined. */
  embeddedLoginDismiss: "embedded:login-dismiss",
  /** Sends the stage rectangle (content area under the chrome) to the manager. */
  embeddedStage: "embedded:stage",
  embeddedOpen: "embedded:open",
  /** Opens a blank tab directly into a named view. */
  embeddedOpenInView: "embedded:open-in-view",
  /** Opens a blank tab pinned to one slot of a view. */
  embeddedOpenInSlot: "embedded:open-in-slot",
  /** Opens a blank page in an existing instance, so one profile gets several tabs. */
  embeddedOpenInInstance: "embedded:open-in-instance",
  /** Duplicates one page into the instance that owns it. */
  embeddedDuplicate: "embedded:duplicate",
  /** Closes every other page of the same instance. */
  embeddedCloseOthers: "embedded:close-others",
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
  /** Launches several identities into one scratch view; owned by the main process. */
  embeddedLaunchBatch: "embedded:launch-batch",
  embeddedViewLayout: "embedded:view-layout",
  /** Groups every loose page into a new view with this layout. */
  embeddedGroupLoose: "embedded:group-loose",
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
  embeddedDevToolsClose: "embedded:devtools-close",
  embeddedDevToolsWidth: "embedded:devtools-width",
  embeddedDevToolsResizeStart: "embedded:devtools-resize-start",
  embeddedDevToolsResizeEnd: "embedded:devtools-resize-end",
  embeddedZoom: "embedded:zoom",
  embeddedViewport: "embedded:viewport",
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
  saveTag(draft: TagDraft): Promise<WorkspaceSnapshot>;
  deleteTag(id: string): Promise<WorkspaceSnapshot>;
  saveIdentity(draft: IdentityDraft): Promise<WorkspaceSnapshot>;
  deleteIdentity(id: string): Promise<WorkspaceSnapshot>;
  /**
   * Points a batch of accounts at one site.
   *
   * The account form has a site picker, but re-linking a dozen accounts one at a
   * time is the kind of chore that ends with them still unlinked. Returns the
   * snapshot so the page updates in one pass.
   */
  linkIdentitiesToSite(identityIds: string[], siteId: string): Promise<WorkspaceSnapshot>;
  /** Deletes the browser profile directory so the next launch starts signed out. */
  rebuildIdentityProfile(id: string): Promise<WorkspaceSnapshot>;
  /** Turns a credential reference into an independent copy with its own password. */
  detachReference(id: string): Promise<WorkspaceSnapshot>;
  saveView(draft: ViewDraft): Promise<WorkspaceSnapshot>;
  deleteView(id: string): Promise<WorkspaceSnapshot>;
  /** Moves a view within the list; the stored array order is the list order. */
  moveView(id: string, toIndex: number): Promise<WorkspaceSnapshot>;
  setViewLayout(viewId: string, layoutId: LayoutId): Promise<WorkspaceSnapshot>;
  setViewSlotAssignments(
    viewId: string,
    assignments: Record<string, number>,
  ): Promise<WorkspaceSnapshot>;
  /** Repositions the windows of one view after its slots changed. */
  retileView(viewId: string): Promise<void>;
  /** Copies a view to another site; members are matched by username. */
  copyViewToSite(viewId: string, targetSiteId: string): Promise<ViewCopyResult>;
  saveFlow(draft: FlowDraft): Promise<WorkspaceSnapshot>;
  deleteFlow(id: string): Promise<WorkspaceSnapshot>;
  /**
   * Adds or renames a plain bookmark. Returns the snapshot rather than the
   * record: the new-tab grid and any open bookmark panel both read from it.
   */
  saveBookmark(draft: BookmarkDraft): Promise<WorkspaceSnapshot>;
  /** Attaches an already-inlined `data:image/*` icon, or clears it. */
  setBookmarkFavicon(id: string, favicon?: string): Promise<WorkspaceSnapshot>;
  deleteBookmark(id: string): Promise<WorkspaceSnapshot>;
  moveBookmark(id: string, toIndex: number): Promise<WorkspaceSnapshot>;
  /** Adds a bookmark folder, or renames and moves an existing one. */
  saveBookmarkFolder(draft: BookmarkFolderDraft): Promise<WorkspaceSnapshot>;
  /** Deletes one folder; its contents re-parent one level up. */
  deleteBookmarkFolder(id: string): Promise<WorkspaceSnapshot>;
  /** Detects importable browser bookmark profiles on this machine. */
  bookmarkImportSources(): Promise<BookmarkImportSourceInfo[]>;
  /** Imports one detected source by id; the snapshot already carries the tree. */
  bookmarkImport(id: string): Promise<{ snapshot: WorkspaceSnapshot; imported: BookmarkImportOutcome }>
  /**
   * Runs a flow. Omitting `identityId` opens a fresh tab as the site's first
   * usable account; the result names the tab so the caller can watch it.
   */
  runFlow(input: {
    flowId: string;
    identityId?: string;
    params?: Record<string, string>;
    tabId?: string;
  }): Promise<FlowRunOutcome>;
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
  /**
   * Writes a shareable account bundle: only the chosen sites and accounts.
   * Distinct from `exportWorkspace`, which is a whole-workspace migration file.
   */
  exportAccounts(options: {
    siteIds: string[];
    identityIds: string[];
    passphrase?: string;
    note?: string;
  }): Promise<AccountsExportOutcome>;
  pickAccountsImport(): Promise<AccountsImportPickOutcome>;
  applyAccountsImport(passphrase?: string): Promise<AccountsImportApplyOutcome>;
  saveSettings(patch: SettingsPatch): Promise<WorkspaceSnapshot>;

  mcpStatus(): Promise<McpStatus>;
  updateMcp(patch: McpPatch): Promise<McpStatus>;
  /** Fires when the endpoint starts, stops, or moves to another port. */
  onMcpChanged(listener: (status: McpStatus) => void): () => void;
  /**
   * Fires whenever an AI client acts on a page, with the site it touched.
   *
   * The dock shows the count so "the AI is operating this site" is visible while
   * it happens; the audit log is the durable record of the same events.
   */
  onAiPageAction(listener: (event: AiPageAction) => void): () => void;

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
    /**
     * Open in the throwaway session instead of the daily profile. Only the
     * explicit "clean open" action sets this; a bookmark or a typed address
     * omits it, so the login already in the daily profile is reused.
     */
    clean?: boolean;
  }): Promise<EmbeddedTab>;
  /** Opens a blank tab into a specific view and returns the new state. */
  openEmbeddedTabInView(viewId: string): Promise<EmbeddedState>;
  /**
   * Opens a blank tab and pins it to `slotIndex`, then focuses it.
   *
   * `identityId` is optional because an empty slot has two legitimate meanings:
   * "just put a page here" (the daily profile, as the address bar would) and
   * "this cell is this account". Without it, filling a grid meant adding a page
   * and then going to find the account elsewhere.
   */
  openEmbeddedTabInSlot(
    viewId: string,
    slotIndex: number,
    identityId?: string,
  ): Promise<EmbeddedState>;
  /**
   * Opens a blank page in an existing instance and shows it.
   *
   * A browser instance is a session, not a single page: one account usually
   * needs a console tab, a docs tab and the page under test at the same time.
   */
  openEmbeddedTabInInstance(instanceId: string): Promise<EmbeddedState>;
  /** Duplicates a page (same instance, same URL) and shows the copy. */
  duplicateEmbeddedTab(tabId: string): Promise<EmbeddedState>;
  /** Closes every page of an instance except `tabId`. */
  closeOtherEmbeddedTabs(tabId: string): Promise<EmbeddedState>;
  /**
   * Opens an identity as a new page in the flat tab strip, even when a view is
   * on stage. This is what clicking an account card means.
   */
  openEmbeddedIdentity(identityId: string): Promise<EmbeddedState>;
  /** Opens (or merges into) the container of a saved view. */
  openEmbeddedView(viewId: string): Promise<EmbeddedState>;
  /** Login fields seen in an embedded page; never includes the password. */
  onLoginCaptured(listener: (notice: LoginCaptureNotice) => void): () => void;
  /** Forgets a pending capture the user declined to save. */
  dismissLoginCapture(token: string): Promise<void>;
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
  /**
   * Launches several identities into one scratch view with the default layout.
   * The main process owns the whole run: pages are created concurrently, pinned
   * by index, and rolled back together when one fails.
   */
  launchEmbeddedIdentities(identityIds: string[]): Promise<EmbeddedState>;
  setEmbeddedViewLayout(viewId: string, layoutId: LayoutId): Promise<EmbeddedState>;
  /** Groups every loose page into a new view with this layout; returns its id. */
  groupLooseTabs(layoutId: LayoutId): Promise<string | undefined>;
  /** Applies slot geometry dragged by hand (fractions of the stage). */
  setEmbeddedViewSlots(viewId: string, rects: SlotRect[]): Promise<EmbeddedState>;
  /** Binds a tab to one slot of a view; null empties the slot. */
  pinEmbeddedTab(viewId: string, slotIndex: number, tabId: string | null): Promise<EmbeddedState>;
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
  /** Opens DevTools for one page; docked inside the page by default. */
  openEmbeddedDevTools(tabId: string, mode?: "docked" | "window"): Promise<void>;
  closeEmbeddedDevTools(tabId: string): Promise<void>;
  /** Sets the docked panel's fraction of the cell; clamped main-process side. */
  setEmbeddedDevToolsWidth(tabId: string, width: number): Promise<void>;
  /** Hands a handle drag to the main process, which follows the cursor itself. */
  beginEmbeddedDevToolsResize(tabId: string): Promise<void>;
  endEmbeddedDevToolsResize(): Promise<void>;
  /**
   * Ctrl +/-/0 on one page. Returns the new factor in percent.
   *
   * Per page on purpose: two accounts side by side may need different sizes (a
   * dense table vs. a form), and a per-site factor would silently apply to every
   * account that happens to share the site.
   */
  zoomEmbeddedTab(tabId: string, direction: "in" | "out" | "reset"): Promise<number>;
  /** Pins a page to a fixed CSS viewport; null returns it to adaptive fill. */
  setEmbeddedViewport(tabId: string, size: { width: number; height: number } | null): Promise<{ width: number; height: number } | null>;
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
