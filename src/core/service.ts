import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountBundleFile,
  accountBundleCounts,
  accountSecretKey,
  type BundleCounts,
  type BundleImportResult,
  type BundlePreview,
  type BundleSecrets,
  buildAccountBundle,
} from "@shared/accounts-transfer";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import { type Flow, type FlowDraft, validateFlow } from "@shared/flows";
import { findLayout, isFreeLayout } from "@shared/layouts";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportCounts,
  type ImportResult,
  type WorkspaceExportFile,
} from "@shared/transfer";
import type {
  AppSettings,
  AuthBatchResult,
  AuthCheckResult,
  AutoFillReport,
  Bookmark,
  BookmarkDraft,
  BookmarkFolder,
  BookmarkFolderDraft,
  CredentialPresence,
  Engine,
  Identity,
  IdentityDraft,
  LaunchResult,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  LoginField,
  OriginChangedNotice,
  PasswordOwner,
  Platform,
  ReloginBatchResult,
  ReloginResult,
  RunningInstance,
  SettingsPatch,
  Site,
  SiteDraft,
  Tag,
  TagDraft,
  View,
  ViewCopyResult,
  ViewDraft,
  ViewRestoreOutcome,
  WorkspaceSnapshot,
} from "@shared/types";
import { evaluate, navigateAndWait, setWindowBounds } from "./cdp/browser";
import {
  bodyMarksSignedOut,
  buildAuthCheckExpression,
  buildFillExpression,
  type FillOutcome,
} from "./cdp/login";
import { createKdfParams, deriveKey, open, seal } from "./credentials/crypto";
import {
  CredentialVault,
  type MissingCredentialReason,
  resolvePassword,
  type SecretBox,
  type VaultFile,
  VaultLockedError,
} from "./credentials/vault";
import { mergeManualEngines, scanEngines } from "./engines";
import { t } from "./i18n/translate";
import { findInstanceByPid } from "./launch/active-instance";
import { cdpRegistry, launchBrowser, stopInstances } from "./launch/browser";
import {
  type HeadlessSession,
  openHeadlessSession,
  supportsHeadlessSession,
} from "./launch/headless";
import {
  activateWindowForPid,
  type FrameInset,
  measureFrameInset,
  type ScreenRect,
  windowRectForPid,
} from "./launch/window-focus";
import {
  computeSlots,
  fullWorkArea,
  inflateRect,
  type Rect,
  singleWindowRect,
} from "./layout/grid";
import { resolveLoginFields } from "./login-fields";
import {
  CLEAN_PROFILE_PREFIX,
  CLEAN_SESSION_SEGMENT,
  isCleanProfileDir,
  removeCleanProfiles,
} from "./processes/clean-profiles";
import {
  type EngineCache,
  emptyWorkspace,
  findOwnedBrowserProcesses,
  sanitizeWorkspace,
  type WorkspaceData,
} from "./processes/registry";
import {
  parseChromiumBookmarks,
  parseFirefoxBookmarks,
  type BookmarkImportNode,
  type BookmarkSourceKind,
} from "./bookmarks-import";
import { JsonStore } from "./storage/json-store";
import { joinUrl, safeExternalUrl, sameOrigin } from "./util/url";

export interface WorkspaceServiceOptions {
  userDataDir: string;
  profileRoot: string;
  platform: Platform;
  secretBox: SecretBox;
  appVersion: string;
  /**
   * The OS language tag, e.g. "zh-CN".
   *
   * Injected rather than read from `process.env` so the renderer can resolve
   * `settings.locale === "system"` against the same value the core layer uses,
   * and so tests can pin it. Optional: without it "system" resolves to English,
   * which is what a test asserting English strings expects anyway.
   */
  systemLocale?: string;
  /** Returns the current window work area, injected by Electron so core stays UI free. */
  workArea?: () => Rect;
  onChange?: () => void;
  /** Reports the outcome of a best-effort fill that ran after a window opened. */
  onAutoFill?: (report: AutoFillReport) => void;
  /**
   * Allow session checks to launch a hidden browser for identities with no
   * window. On by default; unit tests turn it off so a batch check cannot start
   * eight real browsers.
   */
  headlessAuthCheck?: boolean;
}

export class WorkspaceService {
  private readonly store: JsonStore<WorkspaceData>;
  private readonly settingsStore: JsonStore<AppSettings>;
  private readonly engineCacheStore: JsonStore<EngineCache>;
  private readonly vault: CredentialVault;
  private data: WorkspaceData;
  private settings: AppSettings;
  private engines: Engine[] = [];
  private enginesReady = false;
  private needsOrphanSweep = false;
  /**
   * Set when a fill was refused because the site's address differs from the one
   * its password was last used with. The UI reads it once and asks the user.
   */
  private pendingOriginConfirmation: OriginChangedNotice | undefined;
  /** Resolves once startup cleanup finished; clean sessions wait on it. */
  private maintenanceDone: Promise<void> = Promise.resolve();
  private readonly liveInstances = new Map<string, RunningInstance>();
  /**
   * Failed clean-profile deletes, retried until the exiting browser releases its
   * files. Never blocks window close: the promise only keeps the retry alive.
   */
  private readonly cleanProfileRetries = new Map<string, Promise<void>>();
  /**
   * Bounds we last applied to each window. Used to tell "still where the layout
   * put it" from "the user moved or resized it", so a new window never undoes
   * that work.
   */
  private readonly placedBounds = new Map<string, Rect>();
  /** In-flight single launches, so a double click cannot open two browsers. */
  private readonly pendingIdentityLaunches = new Map<string, Promise<LaunchResult>>();
  /**
   * Measured once per launch from Windows' real window frame. Undefined until
   * the first browser reports it, and always undefined on platforms that place
   * windows exactly where they are told.
   */
  private frameInset: FrameInset | undefined;
  /** Startup restore only makes sense once per process. */
  private restoreAttempted = false;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.store = new JsonStore(join(options.userDataDir, "workspace.json"), emptyWorkspace);
    this.settingsStore = new JsonStore(join(options.userDataDir, "settings.json"), () => ({
      ...DEFAULT_SETTINGS,
    }));
    this.engineCacheStore = new JsonStore<EngineCache>(
      join(options.userDataDir, "engines.json"),
      () => ({ version: 1, scannedAt: "", engines: [] }),
    );
    this.data = sanitizeWorkspace(this.store.read());
    this.settings = { ...DEFAULT_SETTINGS, ...this.settingsStore.read() };

    const vaultStore = new JsonStore<VaultFile>(join(options.userDataDir, "vault.json"), () => ({
      version: 2,
      mode: "os",
      site: {},
      identity: {},
    }));
    this.vault = new CredentialVault({
      osBox: options.secretBox,
      persist: (state) => vaultStore.write(state),
      initial: vaultStore.read(),
    });
  }

  async initialize(): Promise<void> {
    // Older builds could store `plain:` payloads when no keyring existed. Rewrite
    // them with OS protection before anything can read them.
    this.vault.migrateLegacyPlaintext();
    // Anything recorded as running from a previous session is stale: the app owns
    // browser lifetimes, so no instance can survive a restart. A non-empty list
    // means the last shutdown was not graceful, so browsers may still be alive.
    this.needsOrphanSweep = this.data.instances.length > 0;
    this.data.instances = [];
    this.persist();
    // Use the cached engine list so the first paint is not blocked by scanning.
    const cached = this.cachedEngines();
    this.engines = mergeManualEngines(cached, this.data.manualEngines);
    this.enginesReady = cached.length > 0;
  }

  /**
   * Slow startup work that must not block the window: reclaim orphaned browsers
   * from a previous crash, then refresh the engine list in the background.
   */
  async startBackgroundMaintenance(): Promise<void> {
    this.maintenanceDone = (async () => {
      if (this.needsOrphanSweep) {
        await this.reapOrphans();
      }
      await this.sweepCleanProfiles();
      await this.scanAvailableEngines();
      this.emit();
    })();
    await this.maintenanceDone;
  }

  private cachedEngines(): Engine[] {
    try {
      const cache = this.engineCacheStore.read();
      if (cache.version !== 1 || !Array.isArray(cache.engines)) return [];
      return cache.engines.filter((engine) => existsSync(engine.exePath));
    } catch {
      return [];
    }
  }

  private writeEngineCache(): void {
    this.engineCacheStore.write({
      version: 1,
      scannedAt: new Date().toISOString(),
      engines: this.engines,
    });
  }

  get profileRoot(): string {
    return this.options.profileRoot;
  }

  get userDataDir(): string {
    return this.options.userDataDir;
  }

  settingsSnapshot(): AppSettings {
    return { ...this.settings };
  }

  async scanAvailableEngines(): Promise<Engine[]> {
    const scanned = await scanEngines(this.options.platform);
    this.engines = mergeManualEngines(scanned, this.data.manualEngines);
    this.enginesReady = true;
    this.writeEngineCache();
    return this.engines;
  }

  enginesSnapshot(): Engine[] {
    return this.engines;
  }

  addManualEngine(exePath: string): void {
    if (!this.data.manualEngines.includes(exePath)) {
      this.data.manualEngines.push(exePath);
      this.persist();
    }
  }

  removeManualEngine(exePath: string): void {
    this.data.manualEngines = this.data.manualEngines.filter((item) => item !== exePath);
    this.persist();
  }

  snapshot(): WorkspaceSnapshot {
    return {
      sites: this.data.sites,
      tags: this.data.tags,
      bookmarks: [...this.data.bookmarks].sort((a, b) => a.order - b.order),
      bookmarkFolders: [...this.data.bookmarkFolders].sort((a, b) => a.order - b.order),
      identities: this.data.identities,
      views: this.data.views,
      flows: this.data.flows,
      engines: this.engines,
      enginesReady: this.enginesReady,
      instances: [...this.liveInstances.values()],
      layoutPresets: this.data.layoutPresets,
      settings: this.settingsSnapshot(),
      credentials: this.credentialPresence(),
      platform: this.options.platform,
      appVersion: this.options.appVersion,
      userDataDir: this.options.userDataDir,
      systemLocale: this.options.systemLocale ?? "",
    };
  }

  credentialPresence(): CredentialPresence {
    const presence = this.vault.presence();
    const mode = this.vault.mode;
    const warning = this.vault.secure
      ? this.vault.hasLegacyPlaintext
        ? t("vault.legacyPlain")
        : undefined
      : this.vault.backend === "basic_text"
        ? t("vault.basicText")
        : t("vault.unavailable");
    return {
      secure: this.vault.secure,
      backend: this.vault.backend,
      mode,
      locked: this.vault.locked,
      canManageMaster: mode === "master" || this.vault.secure,
      ...(warning ? { warning } : {}),
      site: presence.site,
      identity: presence.identity,
    };
  }

  private persist(): void {
    this.store.write(this.data);
    this.options.onChange?.();
  }

  private emit(): void {
    this.options.onChange?.();
  }

  // ---------- sites ----------

  /**
   * Adds or updates a site, optionally with its default password.
   *
   * The password rides on the draft instead of a follow-up `setPassword` call
   * because a new site has no id to address until it is saved: the dialog would
   * have to save, read the new id back, and save again. One write, and a locked
   * vault fails before anything is stored rather than leaving a site whose
   * password silently did not land.
   *
   * `password` empty means "leave whatever is there"; `clearSitePassword` is the
   * explicit removal. Two separate signals because a blank input field is a
   * common accident, and treating it as "delete the saved password" would lose
   * a secret the user never asked to lose.
   */
  saveSite(draft: SiteDraft): Site {
    const now = new Date().toISOString();
    const tagIds = this.resolveTagIds(draft.tagIds);
    const password = typeof draft.password === "string" ? draft.password : "";
    // Checked up front: writing the site and then failing on the vault would
    // leave the dialog reporting an error for a site that now exists.
    if (password || draft.clearSitePassword) this.guardVaultUnlocked();

    let site: Site;
    if (draft.id) {
      const existing = this.data.sites.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.siteMissing"));
      Object.assign(existing, {
        name: draft.name,
        baseUrl: trimTrailingSlash(draft.baseUrl),
        loginPath: draft.loginPath,
        authCheckPath: draft.authCheckPath,
        authCheckSignedOut: draft.authCheckSignedOut,
        autoSubmit: draft.autoSubmit,
        tagIds,
        updatedAt: now,
      });
      site = existing;
    } else {
      site = {
        id: randomUUID(),
        name: draft.name,
        baseUrl: trimTrailingSlash(draft.baseUrl),
        loginPath: draft.loginPath,
        authCheckPath: draft.authCheckPath,
        authCheckSignedOut: draft.authCheckSignedOut,
        autoSubmit: draft.autoSubmit,
        tagIds,
        createdAt: now,
        updatedAt: now,
      };
      this.data.sites.push(site);
    }
    // Only what the user actually did. An empty input and an unfelt checkbox
    // both mean "leave the stored password alone".
    if (password) this.vault.set({ kind: "site", id: site.id }, password);
    else if (draft.clearSitePassword) this.vault.clear({ kind: "site", id: site.id });

    this.persist();
    return site;
  }

  /**
   * Keeps only tag ids that exist. An unknown id is dropped rather than stored:
   * a stale reference would make the site silently disappear from every group.
   */
  private resolveTagIds(tagIds: string[] | undefined): string[] | undefined {
    if (!tagIds) return undefined;
    const known = new Set(this.data.tags.map((tag) => tag.id));
    const kept = [...new Set(tagIds.filter((id) => known.has(id)))];
    return kept.length > 0 ? kept : undefined;
  }

  /**
   * Creates or renames a tag.
   *
   * One namespace for sites, identities and views: the same word describes the
   * same grouping wherever it is applied.
   */
  saveTag(draft: TagDraft): Tag {
    const name = draft.name.trim();
    if (!name) throw new Error(t("error.tagName"));
    const duplicate = this.data.tags.find(
      (tag) => tag.id !== draft.id && tag.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) throw new Error(t("error.tagDuplicate"));
    if (draft.id) {
      const existing = this.data.tags.find((tag) => tag.id === draft.id);
      if (!existing) throw new Error(t("error.tagMissing"));
      existing.name = name;
      existing.color = draft.color;
      this.persist();
      return existing;
    }
    const tag: Tag = {
      id: randomUUID(),
      name,
      color: draft.color,
      createdAt: new Date().toISOString(),
    };
    this.data.tags.push(tag);
    this.persist();
    return tag;
  }

  /**
   * Removes a tag and unlinks it from sites, identities and views.
   *
   * Nothing else changes: a tag never owned behaviour, so deleting one only
   * changes how things are found.
   */
  deleteTag(id: string): void {
    this.data.tags = this.data.tags.filter((tag) => tag.id !== id);
    const now = new Date().toISOString();
    for (const site of this.data.sites) {
      if (!site.tagIds?.includes(id)) continue;
      const kept = site.tagIds.filter((tagId) => tagId !== id);
      site.tagIds = kept.length > 0 ? kept : undefined;
      site.updatedAt = now;
    }
    for (const identity of this.data.identities) {
      if (!identity.tagIds?.includes(id)) continue;
      const kept = identity.tagIds.filter((tagId) => tagId !== id);
      identity.tagIds = kept.length > 0 ? kept : undefined;
      identity.updatedAt = now;
    }
    for (const view of this.data.views) {
      if (!view.tagIds?.includes(id)) continue;
      const kept = view.tagIds.filter((tagId) => tagId !== id);
      view.tagIds = kept.length > 0 ? kept : undefined;
      view.updatedAt = now;
    }
    this.persist();
  }

  deleteSite(id: string): void {
    const identityIds = this.data.identities
      .filter((identity) => identity.siteId === id)
      .map((identity) => identity.id);
    for (const instance of [...this.liveInstances.values()]) {
      if (instance.siteId === id) {
        void this.stopInstance(instance.id);
      }
    }
    const removedViewIds = new Set(
      this.data.views.filter((view) => view.siteId === id).map((view) => view.id),
    );
    this.data.sites = this.data.sites.filter((item) => item.id !== id);
    this.data.identities = this.data.identities.filter((item) => item.siteId !== id);
    this.data.views = this.data.views.filter((item) => item.siteId !== id);
    // A flow is a sequence of steps against one site's UI; without the site it
    // has nowhere to run, so it goes with it rather than lingering as an entry
    // that can only fail.
    this.data.flows = this.data.flows.filter((item) => item.siteId !== id);
    for (const identityId of identityIds) {
      this.vault.clear({ kind: "identity", id: identityId });
    }
    this.vault.clearSite(id);
    if (this.settings.lastViewId && removedViewIds.has(this.settings.lastViewId)) {
      delete this.settings.lastViewId;
      this.settingsStore.write(this.settings);
    }
    this.persist();
  }

  // ---------- identities ----------

  saveIdentity(draft: IdentityDraft, password?: string): Identity {
    const site = this.data.sites.find((item) => item.id === draft.siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    const now = new Date().toISOString();
    // A reference reuses the source wholesale, so validate it before writing
    // anything: pointing at a missing or second-hand reference would produce an
    // identity that cannot log in and gives no clue why.
    const source = this.resolveCredentialSource(draft);
    const tagIds = this.resolveTagIds(draft.tagIds);

    let identity: Identity;
    if (draft.id) {
      const existing = this.data.identities.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.identityMissing"));
      // An identity other identities point at cannot become a reference itself:
      // that would create a chain, and chains are deliberately not supported.
      if (source && this.data.identities.some((item) => item.credentialFrom === existing.id)) {
        throw new Error(t("error.referenceHasDependents"));
      }
      Object.assign(existing, {
        // Without this line the dialog's site picker did nothing on an existing
        // account: every other field was written, so the form reported success
        // while the account stayed where it was.
        siteId: draft.siteId,
        name: source ? source.name : draft.name,
        username: source ? source.username : draft.username,
        role: source ? source.role : draft.role,
        color: source ? source.color : draft.color,
        engineId: draft.engineId,
        startPath: draft.startPath,
        passwordMode: draft.passwordMode,
        credentialFrom: draft.passwordMode === "reference" ? draft.credentialFrom : undefined,
        // Extra login fields belong to the account, so they never follow a reference.
        extraFields: sanitizeLoginFields(draft.extraFields),
        tagIds,
        note: source ? source.note : draft.note,
        updatedAt: now,
      });
      identity = existing;
    } else {
      identity = {
        id: randomUUID(),
        siteId: draft.siteId,
        name: source ? source.name : draft.name,
        username: source ? source.username : draft.username,
        role: source ? source.role : draft.role,
        color: source ? source.color : draft.color,
        engineId: draft.engineId,
        startPath: draft.startPath,
        passwordMode: draft.passwordMode,
        ...(draft.passwordMode === "reference" && draft.credentialFrom
          ? { credentialFrom: draft.credentialFrom }
          : {}),
        extraFields: sanitizeLoginFields(draft.extraFields),
        tagIds,
        note: source ? source.note : draft.note,
        status: "unknown",
        createdAt: now,
        updatedAt: now,
      };
      this.data.identities.push(identity);
    }

    if (password) {
      this.vault.set({ kind: "identity", id: identity.id }, password);
    }
    if (draft.passwordMode === "inherit") {
      this.vault.clear({ kind: "identity", id: identity.id });
    }
    // A reference is "exactly the same account", so editing the source has to
    // reach everyone pointing at it. Without this the copied fields drift and the
    // UI cannot explain why two identities that share a login show different names.
    if (identity.passwordMode !== "reference") this.syncDependents(identity);
    this.persist();
    return identity;
  }

  /**
   * Points a set of accounts at one site.
   *
   * Two jobs, one method: accounts whose site was lost (see the identity type's
   * `siteId` note) get a home again, and moving accounts between sites is the
   * same write. Nothing else about the account changes — credentials, extra
   * fields and tags are the account's own.
   *
   * The external-browser profile lives under `<root>/<siteId>/<id>`, so a moved
   * account starts a fresh profile there. That is acceptable for the re-link
   * case this exists for (an unlinked account could never launch at all); the
   * built-in surface keeps its session, because its partition is keyed by the
   * account id.
   */
  linkIdentitiesToSite(identityIds: string[], siteId: string): { linked: number } {
    const site = this.data.sites.find((item) => item.id === siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    const wanted = new Set(identityIds.map(String));
    const now = new Date().toISOString();
    let linked = 0;
    for (const identity of this.data.identities) {
      if (!wanted.has(identity.id) || identity.siteId === site.id) continue;
      identity.siteId = site.id;
      identity.updatedAt = now;
      linked += 1;
    }
    if (linked > 0) this.persist();
    return { linked };
  }

  /** Copies the synced fields of a reference source onto everyone referencing it. */
  private syncDependents(source: Identity): void {
    for (const dependent of this.data.identities) {
      if (dependent.credentialFrom !== source.id) continue;
      dependent.name = source.name;
      dependent.username = source.username;
      dependent.role = source.role;
      dependent.color = source.color;
      dependent.note = source.note;
      dependent.updatedAt = source.updatedAt;
    }
  }

  /**
   * Validates and returns the identity a reference points at.
   *
   * Returns undefined for non-reference modes. A reference must name an existing
   * identity that is not itself a reference, and may not point at itself.
   */
  private resolveCredentialSource(draft: IdentityDraft): Identity | undefined {
    if (draft.passwordMode !== "reference") return undefined;
    const sourceId = draft.credentialFrom;
    if (!sourceId) throw new Error(t("error.referenceMissing"));
    if (sourceId === draft.id) throw new Error(t("error.referenceSelf"));
    const source = this.data.identities.find((item) => item.id === sourceId);
    if (!source) throw new Error(t("error.referenceMissing"));
    if (source.passwordMode === "reference") throw new Error(t("error.referenceChain"));
    return source;
  }

  /**
   * Turns a reference into an independent copy.
   *
   * The resolved password is written as the identity's own `custom` credential, so
   * detaching can never fall back to the site default and silently change which
   * password is used. Synced display fields keep their current values.
   */
  detachReference(id: string): Identity {
    const identity = this.data.identities.find((item) => item.id === id);
    if (!identity) throw new Error(t("error.identityMissing"));
    if (identity.passwordMode !== "reference") return identity;
    const resolved = resolvePassword(this.vault, identity, identity.siteId, this.data.identities);
    if (!resolved.password) throw new Error(t("error.referenceMissing"));
    this.vault.set({ kind: "identity", id: identity.id }, resolved.password);
    identity.passwordMode = "custom";
    identity.credentialFrom = undefined;
    identity.updatedAt = new Date().toISOString();
    this.persist();
    return identity;
  }

  deleteIdentity(id: string): void {
    for (const instance of [...this.liveInstances.values()]) {
      if (instance.identityId === id) void this.stopInstance(instance.id);
    }
    // Identities referencing this one would otherwise have no way to log in and
    // no visible reason why. Materialise the resolved password into each of them
    // before the source disappears.
    const dependents = this.data.identities.filter((item) => item.credentialFrom === id);
    const resolved = resolvePassword(
      this.vault,
      { id, passwordMode: "custom" },
      "",
      this.data.identities,
    );
    for (const dependent of dependents) {
      if (resolved.password) {
        this.vault.set({ kind: "identity", id: dependent.id }, resolved.password);
        dependent.passwordMode = "custom";
      } else {
        dependent.passwordMode = "inherit";
      }
      dependent.credentialFrom = undefined;
      dependent.updatedAt = new Date().toISOString();
    }
    this.data.identities = this.data.identities.filter((item) => item.id !== id);
    for (const view of this.data.views) {
      view.identityIds = view.identityIds.filter((identityId) => identityId !== id);
      delete view.slotAssignments[id];
      delete view.paths[id];
    }
    this.data.views = this.data.views.filter((view) => view.identityIds.length > 0);
    this.vault.clear({ kind: "identity", id });
    this.persist();
  }

  /**
   * Drops the browser profile directory for one identity. Useful when a profile was
   * polluted before sync was disabled, or when the site's own state got corrupted.
   * Credentials stored in the vault are kept; only browser-side state is removed.
   */
  async rebuildIdentityProfile(id: string): Promise<void> {
    const identity = this.data.identities.find((item) => item.id === id);
    if (!identity) throw new Error(t("error.identityMissing"));

    const running = [...this.liveInstances.values()].find((instance) => instance.identityId === id);
    if (running) {
      await this.stopInstance(running.id);
    }

    const dir = this.profileDirFor(id);
    if (dir) await rm(dir, { recursive: true, force: true });

    identity.status = "unknown";
    identity.lastCheckedAt = undefined;
    identity.updatedAt = new Date().toISOString();
    this.persist();
  }

  // ---------- views ----------

  private presetFor(layoutId: LayoutId): LayoutPreset {
    return findLayout(layoutId, this.data.layoutPresets);
  }

  /**
   * Keeps assignments honest: only member ids survive, and only slot indices that
   * exist in the referenced preset. Missing entries are filled at launch time in
   * member order, so an old view without assignments still opens sensibly.
   */
  private sanitizeAssignments(
    layout: LayoutPreset,
    identityIds: string[],
    assignments: Record<string, number>,
  ): Record<string, number> {
    if (isFreeLayout(layout)) return {};
    const members = new Set(identityIds);
    const result: Record<string, number> = {};
    for (const [identityId, slotIndex] of Object.entries(assignments ?? {})) {
      if (!members.has(identityId)) continue;
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= layout.slots.length)
        continue;
      result[identityId] = slotIndex;
    }
    return result;
  }

  saveView(draft: ViewDraft): View {
    const site = this.data.sites.find((item) => item.id === draft.siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    // Members may come from any site: a view is one screen, not one deployment.
    // `siteId` stays the view's home — it records where the definition was made.
    const known = new Set(this.data.identities.map((identity) => identity.id));
    const identityIds = draft.identityIds.filter((id) => known.has(id));
    if (identityIds.length === 0) throw new Error(t("error.viewMembers"));
    const tagIds = this.resolveTagIds(draft.tagIds);

    const layout = this.presetFor(draft.layoutId);
    const slotAssignments = this.sanitizeAssignments(layout, identityIds, draft.slotAssignments);
    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.data.views.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.viewMissing"));
      Object.assign(existing, {
        name: draft.name,
        identityIds,
        layoutId: layout.id,
        slotAssignments,
        paths: draft.paths,
        tagIds,
        updatedAt: now,
      });
      this.persist();
      return existing;
    }

    const view: View = {
      id: randomUUID(),
      siteId: draft.siteId,
      name: draft.name,
      identityIds,
      layoutId: layout.id,
      slotAssignments,
      paths: draft.paths,
      tagIds,
      createdAt: now,
      updatedAt: now,
    };
    this.data.views.push(view);
    this.persist();
    return view;
  }

  /**
   * Copies a view to another site, resolving each member to an identity there.
   *
   * Matching is by username: if the target site already has that account the view
   * just uses it. Otherwise a new identity is created on the target that *references*
   * the source identity's credentials, so the two keep sharing a password until the
   * user detaches one. Session state is never shared — each side has its own
   * profile and partition.
   *
   * The copy is independent (`copiedFrom` records provenance only); syncing later
   * is an explicit action, not live linkage.
   */
  copyViewToSite(sourceViewId: string, targetSiteId: string): ViewCopyResult {
    const source = this.data.views.find((item) => item.id === sourceViewId);
    if (!source) throw new Error(t("error.viewMissing"));
    const target = this.data.sites.find((item) => item.id === targetSiteId);
    if (!target) throw new Error(t("error.siteMissing"));
    if (target.id === source.siteId) throw new Error(t("error.copySameSite"));

    const createdReferences: string[] = [];
    const reused: string[] = [];
    const skipped: string[] = [];
    const mapped: string[] = [];

    for (const sourceIdentityId of source.identityIds) {
      const from = this.data.identities.find((item) => item.id === sourceIdentityId);
      if (!from) {
        skipped.push(sourceIdentityId);
        continue;
      }
      const existing = this.data.identities.find(
        (item) => item.siteId === target.id && item.username === from.username,
      );
      if (existing) {
        mapped.push(existing.id);
        reused.push(from.username);
        continue;
      }
      if (from.passwordMode === "reference") {
        // The source has no credentials of its own, so there is nothing to share;
        // copying it would produce a reference to a reference.
        skipped.push(from.username);
        continue;
      }
      const now = new Date().toISOString();
      const created: Identity = {
        id: randomUUID(),
        siteId: target.id,
        name: from.name,
        username: from.username,
        role: from.role,
        color: from.color,
        passwordMode: "reference",
        credentialFrom: from.id,
        ...(from.startPath ? { startPath: from.startPath } : {}),
        ...(from.engineId ? { engineId: from.engineId } : {}),
        status: "unknown",
        createdAt: now,
        updatedAt: now,
      };
      this.data.identities.push(created);
      mapped.push(created.id);
      createdReferences.push(from.username);
    }

    if (mapped.length === 0) throw new Error(t("error.copyNoMembers"));

    const layout = this.presetFor(source.layoutId);
    const view: View = {
      id: randomUUID(),
      siteId: target.id,
      name: source.name,
      identityIds: mapped,
      layoutId: layout.id,
      // Slot assignments are by identity id, so they are rebuilt from member order
      // rather than copied over — the ids are different people on this site.
      slotAssignments: {},
      paths: {},
      // Tags describe the arrangement, not the site it came from, so they follow.
      ...(source.tagIds ? { tagIds: [...source.tagIds] } : {}),
      copiedFrom: { siteId: source.siteId, viewId: source.id },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.data.views.push(view);
    this.persist();
    return { view, createdReferences, reused, skipped };
  }

  deleteView(id: string): void {
    this.data.views = this.data.views.filter((item) => item.id !== id);
    if (this.settings.lastViewId === id) {
      delete this.settings.lastViewId;
      this.settingsStore.write(this.settings);
    }
    this.persist();
  }

  /**
   * Moves a view within the list.
   *
   * The stored order *is* the list order: `data.views` is a JSON array, so the
   * order a user drags into is the order that survives a restart, and nothing has
   * to keep a parallel `order` field in sync with it. `toIndex` is the position
   * the view should occupy after the move, counting from 0 in the list the user
   * is looking at.
   */
  moveView(id: string, toIndex: number): void {
    const from = this.data.views.findIndex((item) => item.id === id);
    if (from < 0) throw new Error(t("error.viewMissing"));
    const [moved] = this.data.views.splice(from, 1);
    if (!moved) return;
    const target = Math.max(0, Math.min(this.data.views.length, Math.trunc(toIndex)));
    this.data.views.splice(target, 0, moved);
    this.persist();
  }

  /**
   * Creates or updates a flow.
   *
   * Validation happens here rather than in the dialog so every entry point —
   * UI, IPC and MCP — rejects the same definitions with the same messages. A
   * flow that references an undefined variable would otherwise fail halfway
   * through a run, after it has already touched the page.
   */
  saveFlow(draft: FlowDraft): Flow {
    const site = this.data.sites.find((item) => item.id === draft.siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    const name = draft.name.trim();
    if (!name) throw new Error("流程名称不能为空");
    const params = (draft.params ?? []).map((param) => ({ ...param }));
    const steps = draft.steps.map((step) => ({ ...step }));
    const problems = validateFlow({ params, steps });
    if (problems.length > 0) throw new Error(problems.join("；"));

    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.data.flows.find((item) => item.id === draft.id);
      if (!existing) throw new Error("流程不存在");
      Object.assign(existing, {
        siteId: draft.siteId,
        name,
        description: (draft.description ?? "").trim(),
        params,
        steps,
        updatedAt: now,
      });
      this.persist();
      return existing;
    }

    const flow: Flow = {
      id: randomUUID(),
      siteId: draft.siteId,
      name,
      description: (draft.description ?? "").trim(),
      params,
      steps,
      createdAt: now,
      updatedAt: now,
    };
    this.data.flows.push(flow);
    this.persist();
    return flow;
  }

  deleteFlow(id: string): void {
    const before = this.data.flows.length;
    this.data.flows = this.data.flows.filter((item) => item.id !== id);
    if (this.data.flows.length === before) throw new Error("流程不存在");
    this.persist();
  }

  // ---------- bookmarks ----------

  /**
   * Adds or renames a bookmark.
   *
   * The URL is validated here rather than when it is opened: a stored bookmark
   * that the surface refuses is a row that fails on click, and by then the user
   * has already forgotten what they were doing. Only http(s) survives, the same
   * rule `normalizeEmbeddedUrl` applies to a typed address.
   *
   * A bare host is accepted (`example.com`) because that is what people paste;
   * https is assumed, which matches what the address bar does with the same
   * input. A scheme that is present but not http(s) is rejected, not rewritten:
   * silently turning `javascript:…` into a "bookmark" is what this check exists
   * to prevent.
   */
  saveBookmark(draft: BookmarkDraft): Bookmark {
    const raw = draft.url.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    const normalized = safeExternalUrl(hasScheme ? raw : `https://${raw}`);
    if (!normalized) throw new Error("书签地址必须是 http(s) 链接");
    const name = draft.name.trim().slice(0, 120) || new URL(normalized).host;
    // Empty means "unfiled", so a cleared folder field is not a folder id of "".
    // A known id is required here rather than silently kept or dropped: saving a
    // bookmark into a folder that does not exist is a bug in the caller, and
    // filing it to unfiled instead would hide that bug behind a moved bookmark.
    const folderId = draft.folderId?.trim() || undefined;
    if (folderId && !this.data.bookmarkFolders.some((item) => item.id === folderId)) {
      throw new Error("文件夹不存在");
    }
    const now = new Date().toISOString();

    if (draft.id) {
      const existing = this.data.bookmarks.find((item) => item.id === draft.id);
      if (!existing) throw new Error("书签不存在");
      existing.name = name;
      existing.url = normalized;
      if (folderId) existing.folderId = folderId;
      else delete existing.folderId;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    // Sorted after everything else, so the grid keeps the order bookmarks were
    // added in rather than reshuffling when one is edited.
    const order = this.data.bookmarks.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    const bookmark: Bookmark = {
      id: randomUUID(),
      name,
      url: normalized,
      ...(folderId ? { folderId } : {}),
      order,
      createdAt: now,
      updatedAt: now,
    };
    this.data.bookmarks.push(bookmark);
    this.persist();
    return bookmark;
  }

  /**
   * Adds a folder, or renames and moves an existing one.
   *
   * One call covers all three because they are the same write: the tree owns
   * names and parents, so renaming never touches the bookmarks inside and
   * moving a subtree is a single `parentId` change. Moving under a descendant
   * of the folder itself is refused — that closes a cycle and would detach the
   * subtree from the root.
   */
  saveBookmarkFolder(draft: BookmarkFolderDraft): BookmarkFolder {
    const name = draft.name.trim().slice(0, 60);
    if (!name) throw new Error("文件夹名称不能为空");
    const parentId = draft.parentId?.trim() || undefined;
    if (parentId && !this.data.bookmarkFolders.some((item) => item.id === parentId)) {
      throw new Error("文件夹不存在");
    }
    const now = new Date().toISOString();

    if (draft.id) {
      const existing = this.data.bookmarkFolders.find((item) => item.id === draft.id);
      if (!existing) throw new Error("文件夹不存在");
      if (parentId && this.isBookmarkFolderDescendant(parentId, existing.id)) {
        throw new Error("不能把文件夹移动到它自己的子文件夹里");
      }
      existing.name = name;
      if (parentId) existing.parentId = parentId;
      else delete existing.parentId;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    // Append among the new siblings, mirroring how bookmarks are ordered.
    const siblings = this.data.bookmarkFolders.filter(
      (item) => (item.parentId ?? undefined) === parentId,
    );
    const order = siblings.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    const folder: BookmarkFolder = {
      id: randomUUID(),
      name,
      ...(parentId ? { parentId } : {}),
      order,
      createdAt: now,
      updatedAt: now,
    };
    this.data.bookmarkFolders.push(folder);
    this.persist();
    return folder;
  }

  /** True when `maybeAncestorId` is `folderId` itself or one of its ancestors. */
  private isBookmarkFolderDescendant(maybeAncestorId: string, folderId: string): boolean {
    let cursor = this.data.bookmarkFolders.find((item) => item.id === maybeAncestorId);
    while (cursor) {
      if (cursor.id === folderId) return true;
      cursor = cursor.parentId
        ? this.data.bookmarkFolders.find((item) => item.id === cursor?.parentId)
        : undefined;
    }
    return false;
  }

  /**
   * Merges one browser profile's bookmarks under a top-level folder named
   * after the browser.
   *
   * Import is deliberately structure-faithful and idempotent: the browser's own
   * group folders (书签栏, 书签工具栏…) come over as folders, urls already in
   * the workspace are skipped, and folders whose subtree lost every bookmark
   * to that dedupe are pruned — so importing the same profile twice leaves the
   * tree as if it had been imported once. A repeated import merges into the
   * existing browser folder rather than stacking a second copy of it.
   */
  async importBookmarksFromSource(source: {
    kind: BookmarkSourceKind;
    browser: string;
    profile: string;
    file: string;
  }): Promise<{ bookmarks: number; folders: number; skipped: number }> {
    const tree =
      source.kind === "firefox"
        ? await parseFirefoxBookmarks(source.file)
        : parseChromiumBookmarks(source.file);
    if (!tree.length) throw new Error("这个配置里没有可导入的书签");
    const now = new Date().toISOString();
    const browserLabel = `${source.browser} 书签`;

    const existingRoot = this.data.bookmarkFolders.find(
      (folder) => !folder.parentId && folder.name === browserLabel,
    );
    const rootWasNew = !existingRoot;
    let root = existingRoot;
    if (!root) {
      const siblings = this.data.bookmarkFolders.filter((folder) => !folder.parentId);
      root = {
        id: randomUUID(),
        name: browserLabel,
        order: siblings.reduce((max, item) => Math.max(max, item.order), -1) + 1,
        createdAt: now,
        updatedAt: now,
      };
      this.data.bookmarkFolders.push(root);
    }

    const seen = new Set(this.data.bookmarks.map((bookmark) => canonicalBookmarkUrl(bookmark.url)));
    const created: BookmarkFolder[] = [];
    let bookmarksAdded = 0;
    let skipped = 0;
    let nextOrder = this.data.bookmarks.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    const walk = (nodes: BookmarkImportNode[], parentId: string): void => {
      for (const node of nodes) {
        if (node.url) {
          // Both sides go through the same canonical form: a stored URL carries
          // safeExternalUrl's normalization (trailing slash, host case), and a
          // raw comparison would import the same address twice.
          const key = canonicalBookmarkUrl(node.url);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          this.data.bookmarks.push({
            id: randomUUID(),
            name: node.name || new URL(node.url).host,
            url: safeExternalUrl(node.url) ?? node.url,
            folderId: parentId,
            order: nextOrder++,
            createdAt: now,
            updatedAt: now,
          });
          bookmarksAdded += 1;
          continue;
        }
        if (!node.children?.length) continue;
        const siblings = this.data.bookmarkFolders.filter(
          (folder) => folder.parentId === parentId,
        );
        const folder: BookmarkFolder = {
          id: randomUUID(),
          name: node.name.slice(0, 60) || "未命名文件夹",
          parentId,
          order: siblings.reduce((max, item) => Math.max(max, item.order), -1) + 1,
          createdAt: now,
          updatedAt: now,
        };
        this.data.bookmarkFolders.push(folder);
        created.push(folder);
        walk(node.children, folder.id);
      }
    };
    walk(tree, root.id);

    // A folder is only worth keeping if something landed in its subtree; the
    // dedupe above can empty whole branches of an already-imported profile.
    const hasContent = (folderId: string): boolean =>
      this.data.bookmarks.some((bookmark) => bookmark.folderId === folderId) ||
      this.data.bookmarkFolders.some(
        (folder) => folder.parentId === folderId && hasContent(folder.id),
      );
    const empty = created.filter((folder) => !hasContent(folder.id));
    if (empty.length) {
      const emptyIds = new Set(empty.map((folder) => folder.id));
      this.data.bookmarkFolders = this.data.bookmarkFolders.filter(
        (folder) => !emptyIds.has(folder.id),
      );
    }
    if (rootWasNew && !hasContent(root.id)) {
      this.data.bookmarkFolders = this.data.bookmarkFolders.filter((folder) => folder.id !== root?.id);
    }

    this.persist();
    return { bookmarks: bookmarksAdded, folders: created.length - empty.length, skipped };
  }

  /**
   * Deletes one folder and re-parents its contents one level up.
   *
   * Nothing is destroyed and nothing is orphaned: subfolders stay folders, the
   * bookmarks inside follow to the same parent (or to unfiled at the top), so
   * the delete is always a pure reorganisation the user can undo by hand.
   */
  deleteBookmarkFolder(id: string): { folders: number; bookmarks: number } {
    const folder = this.data.bookmarkFolders.find((item) => item.id === id);
    if (!folder) throw new Error("文件夹不存在");
    const parentId = folder.parentId;
    const now = new Date().toISOString();
    let folders = 0;
    for (const child of this.data.bookmarkFolders) {
      if (child.parentId !== id) continue;
      if (parentId) child.parentId = parentId;
      else delete child.parentId;
      child.updatedAt = now;
      folders += 1;
    }
    let bookmarks = 0;
    for (const bookmark of this.data.bookmarks) {
      if (bookmark.folderId !== id) continue;
      if (parentId) bookmark.folderId = parentId;
      else delete bookmark.folderId;
      bookmark.updatedAt = now;
      bookmarks += 1;
    }
    this.data.bookmarkFolders = this.data.bookmarkFolders.filter((item) => item.id !== id);
    this.persist();
    return { folders, bookmarks };
  }

  /** Stores the icon a tab has, so the grid can draw it without a fetch. */
  setBookmarkFavicon(id: string, favicon: string | undefined): Bookmark {
    const bookmark = this.data.bookmarks.find((item) => item.id === id);
    if (!bookmark) throw new Error("书签不存在");
    if (favicon && favicon.startsWith("data:image/")) bookmark.favicon = favicon;
    else delete bookmark.favicon;
    this.persist();
    return bookmark;
  }

  deleteBookmark(id: string): void {
    const before = this.data.bookmarks.length;
    this.data.bookmarks = this.data.bookmarks.filter((item) => item.id !== id);
    if (this.data.bookmarks.length === before) throw new Error("书签不存在");
    this.persist();
  }

  /** Moves a bookmark to an explicit position and renumbers the rest. */
  moveBookmark(id: string, toIndex: number): void {
    const from = this.data.bookmarks.findIndex((item) => item.id === id);
    if (from < 0) throw new Error("书签不存在");
    const [moved] = this.data.bookmarks.splice(from, 1);
    if (!moved) return;
    const target = Math.max(0, Math.min(this.data.bookmarks.length, Math.trunc(toIndex)));
    this.data.bookmarks.splice(target, 0, moved);
    this.data.bookmarks.forEach((item, index) => {
      item.order = index;
    });
    this.persist();
  }

  /** Switching the preset clears assignments that no longer point at a real slot. */
  setViewLayout(viewId: string, layoutId: LayoutId): void {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) throw new Error(t("error.viewMissing"));
    const layout = this.presetFor(layoutId);
    view.layoutId = layout.id;
    view.slotAssignments = this.sanitizeAssignments(layout, view.identityIds, view.slotAssignments);
    view.updatedAt = new Date().toISOString();
    this.persist();
  }

  setViewSlotAssignments(viewId: string, assignments: Record<string, number>): void {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) throw new Error(t("error.viewMissing"));
    const layout = this.presetFor(view.layoutId);
    view.slotAssignments = this.sanitizeAssignments(layout, view.identityIds, assignments);
    view.updatedAt = new Date().toISOString();
    this.persist();
  }

  /**
   * Moves the windows a view already has open to match its slot assignments.
   * Dragging a member to another slot is pointless if the browser window does not
   * follow, so this is called right after an assignment change.
   */
  async retileView(viewId: string): Promise<void> {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) return;
    const preset = this.presetFor(view.layoutId);
    const area = this.workArea();
    const taken = new Set<number>();
    await Promise.all(
      view.identityIds.map(async (identityId, index) => {
        const instance = [...this.liveInstances.values()].find(
          (item) => item.identityId === identityId,
        );
        if (!instance || instance.mode !== "cdp" || !instance.targetId) return;
        const identity = this.data.identities.find((item) => item.id === identityId);
        if (!identity) return;
        const slotIndex = this.resolveSlotIndex(
          preset,
          identity,
          view.slotAssignments,
          taken,
          index,
        );
        taken.add(slotIndex);
        const entry = cdpRegistry.get(instance.id);
        if (!entry) return;
        instance.layoutId = preset.id;
        instance.slotIndex = slotIndex;
        await setWindowBounds(
          entry.browser,
          instance.targetId,
          this.slotBounds(preset, area, slotIndex),
        ).catch(() => {});
      }),
    );
  }

  // ---------- layout presets ----------

  saveLayoutPreset(draft: LayoutPresetDraft): LayoutPreset {
    const name = draft.name.trim();
    if (!name) throw new Error(t("error.layoutName"));
    const slots = draft.slots
      .filter(
        (slot) =>
          Number.isFinite(slot.x) &&
          Number.isFinite(slot.y) &&
          Number.isFinite(slot.width) &&
          Number.isFinite(slot.height),
      )
      .map((slot) => ({
        x: roundFraction(slot.x),
        y: roundFraction(slot.y),
        width: roundFraction(slot.width),
        height: roundFraction(slot.height),
      }));
    if (slots.length === 0) throw new Error(t("error.layoutSlots"));

    if (draft.id) {
      const existing = this.data.layoutPresets.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.layoutMissing"));
      Object.assign(existing, { name, slots });
      this.persist();
      return existing;
    }

    const preset: LayoutPreset = { id: randomUUID(), name, slots, builtin: false };
    this.data.layoutPresets.push(preset);
    this.persist();
    return preset;
  }

  deleteLayoutPreset(id: LayoutId): void {
    const preset = this.data.layoutPresets.find((item) => item.id === id);
    if (!preset) return;
    this.data.layoutPresets = this.data.layoutPresets.filter((item) => item.id !== id);
    // Views must never dangle on a deleted preset; fall back to the default grid.
    for (const view of this.data.views) {
      if (view.layoutId !== id) continue;
      view.layoutId = "2x2";
      view.slotAssignments = {};
      view.updatedAt = new Date().toISOString();
    }
    this.persist();
  }

  // ---------- export / import ----------

  /**
   * Builds a portable snapshot. Volatile state (login status, browser profiles,
   * running instances) is deliberately dropped: it belongs to this machine.
   * Secrets are only included when a passphrase is supplied, sealed with the same
   * scrypt + AES-256-GCM construction as the vault.
   */
  exportWorkspace(passphrase?: string): {
    file: WorkspaceExportFile;
    counts: ReturnType<typeof exportCounts>;
    secretsIncluded: boolean;
  } {
    const file: WorkspaceExportFile = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sites: this.data.sites.map((item) => ({ ...item })),
      identities: this.data.identities.map((item) => {
        const { lastCheckedAt: _checked, ...rest } = item;
        return { ...rest, status: "unknown" as const };
      }),
      views: this.data.views.map((item) => ({
        ...item,
        identityIds: [...item.identityIds],
        slotAssignments: { ...item.slotAssignments },
        paths: { ...item.paths },
      })),
      flows: this.data.flows.map((flow) => ({
        ...flow,
        params: flow.params.map((param) => ({ ...param })),
        steps: flow.steps.map((step) => ({ ...step })),
      })),
      layoutPresets: this.data.layoutPresets.map((item) => ({
        ...item,
        slots: item.slots.map((slot) => ({ ...slot })),
      })),
      bookmarks: this.data.bookmarks.map((item) => ({ ...item })),
      bookmarkFolders: this.data.bookmarkFolders.map((item) => ({ ...item })),
    };

    if (passphrase) {
      if (this.vault.locked) throw new Error(t("vault.locked"));
      const secrets = {
        site: {} as Record<string, string>,
        identity: {} as Record<string, string>,
      };
      for (const site of this.data.sites) {
        const password = this.vault.get({ kind: "site", id: site.id });
        if (password) secrets.site[site.id] = password;
      }
      for (const identity of this.data.identities) {
        const password = this.vault.get({ kind: "identity", id: identity.id });
        if (password) secrets.identity[identity.id] = password;
      }
      const kdf = createKdfParams();
      file.secrets = { kdf, payload: seal(deriveKey(passphrase, kdf), JSON.stringify(secrets)) };
    }

    return { file, counts: exportCounts(file), secretsIncluded: Boolean(file.secrets) };
  }

  /**
   * Merges a validated export into the current workspace. Entries whose
   * site is missing are skipped rather than attached to the wrong scope.
   */
  importWorkspace(file: WorkspaceExportFile, passphrase?: string): ImportResult {
    let secrets: { site: Record<string, string>; identity: Record<string, string> } | undefined;
    if (file.secrets) {
      if (!passphrase) throw new Error(t("error.importNeedsPassphrase"));
      try {
        const key = deriveKey(passphrase, file.secrets.kdf);
        const parsed = JSON.parse(open(key, file.secrets.payload)) as {
          site?: Record<string, string>;
          identity?: Record<string, string>;
        };
        secrets = {
          site: parsed.site ?? {},
          identity: parsed.identity ?? {},
        };
      } catch {
        throw new Error(t("error.importPassphrase"));
      }
      // Writing needs the encryption key, so a locked master-password vault must
      // be unlocked first rather than importing everything except the passwords.
      if (this.vault.locked) throw new Error(t("vault.locked"));
    }

    let added = 0;
    let updated = 0;

    for (const site of file.sites) {
      const existing = this.data.sites.find((item) => item.id === site.id);
      if (existing) {
        Object.assign(existing, site, { updatedAt: new Date().toISOString() });
        updated += 1;
      } else {
        this.data.sites.push({ ...site });
        added += 1;
      }
    }

    const siteIds = new Set(this.data.sites.map((item) => item.id));
    let skipped = 0;
    for (const identity of file.identities) {
      if (!identity.siteId || !siteIds.has(identity.siteId)) {
        skipped += 1;
        continue;
      }
      const existing = this.data.identities.find((item) => item.id === identity.id);
      if (existing) {
        Object.assign(existing, identity, { updatedAt: new Date().toISOString() });
        updated += 1;
      } else {
        this.data.identities.push({ ...identity });
        added += 1;
      }
    }

    const identityIds = new Set(this.data.identities.map((item) => item.id));
    for (const view of file.views) {
      if (!siteIds.has(view.siteId)) {
        skipped += 1;
        continue;
      }
      const members = view.identityIds.filter((id) => identityIds.has(id));
      if (members.length === 0) {
        skipped += 1;
        continue;
      }
      const slots = Object.fromEntries(
        Object.entries(view.slotAssignments).filter(([id]) => members.includes(id)),
      );
      const existing = this.data.views.find((item) => item.id === view.id);
      if (existing) {
        Object.assign(existing, view, {
          identityIds: members,
          slotAssignments: slots,
          updatedAt: new Date().toISOString(),
        });
        updated += 1;
      } else {
        this.data.views.push({ ...view, identityIds: members, slotAssignments: slots });
        added += 1;
      }
    }

    /*
     * Flows merge by id like everything else, but a flow whose site is not in
     * this workspace is skipped: the steps are written against that site's UI,
     * and re-homing them onto a different site would point them at a page they
     * were never meant for.
     */
    for (const flow of file.flows ?? []) {
      if (!siteIds.has(flow.siteId)) {
        skipped += 1;
        continue;
      }
      const existing = this.data.flows.find((item) => item.id === flow.id);
      if (existing) {
        Object.assign(existing, flow, {
          params: flow.params.map((param) => ({ ...param })),
          steps: flow.steps.map((step) => ({ ...step })),
          updatedAt: new Date().toISOString(),
        });
        updated += 1;
      } else {
        this.data.flows.push({
          ...flow,
          params: flow.params.map((param) => ({ ...param })),
          steps: flow.steps.map((step) => ({ ...step })),
        });
        added += 1;
      }
    }

    const builtinIds = new Set(["free", "1x1", "2x1", "1x2", "2x2", "3x1"]);
    for (const preset of file.layoutPresets) {
      if (builtinIds.has(preset.id)) continue;
      const existing = this.data.layoutPresets.find((item) => item.id === preset.id);
      if (existing) {
        Object.assign(existing, preset, { builtin: false });
        updated += 1;
      } else {
        this.data.layoutPresets.push({ ...preset, builtin: false });
        added += 1;
      }
    }

    /*
     * Folders merge before the bookmarks that point at them, so every imported
     * `folderId` resolves in one pass. Bookmarks have no site to belong to, so
     * nothing is skipped for them. Their `order` is reassigned from the end
     * rather than trusted: the incoming file knows only its own ordering, and
     * letting it write absolute keys would drop imported bookmarks in between
     * the ones already here.
     */
    for (const folder of file.bookmarkFolders ?? []) {
      const existing = this.data.bookmarkFolders.find((item) => item.id === folder.id);
      if (existing) {
        Object.assign(existing, folder, { updatedAt: new Date().toISOString() });
        updated += 1;
      } else {
        this.data.bookmarkFolders.push({ ...folder });
        added += 1;
      }
    }
    let nextOrder = this.data.bookmarks.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    const importedBookmarks = [...(file.bookmarks ?? [])].sort((a, b) => a.order - b.order);
    for (const bookmark of importedBookmarks) {
      const existing = this.data.bookmarks.find((item) => item.id === bookmark.id);
      if (existing) {
        Object.assign(existing, bookmark, {
          order: existing.order,
          updatedAt: new Date().toISOString(),
        });
        // Object.assign cannot express "the import says unfiled": a missing key
        // would leave the local folder in place, so the field is set or cleared
        // explicitly like `saveBookmark` does.
        if (bookmark.folderId) existing.folderId = bookmark.folderId;
        else delete existing.folderId;
        updated += 1;
      } else {
        this.data.bookmarks.push({ ...bookmark, order: nextOrder });
        nextOrder += 1;
        added += 1;
      }
    }

    let importedSecrets = 0;
    if (secrets) {
      for (const [id, password] of Object.entries(secrets.site)) {
        if (!siteIds.has(id)) continue;
        this.vault.set({ kind: "site", id }, password);
        importedSecrets += 1;
      }
      for (const [id, password] of Object.entries(secrets.identity)) {
        if (!identityIds.has(id)) continue;
        this.vault.set({ kind: "identity", id }, password);
        importedSecrets += 1;
      }
    }

    this.persist();
    return {
      ...exportCounts(file),
      added,
      updated,
      importedSecrets,
      skipped,
    };
  }

  // ---------- account bundles (share a subset of accounts) ----------

  /**
   * Packages selected sites/accounts for another person.
   *
   * Separate from `exportWorkspace` on purpose: that one is a machine-migration
   * file (everything, ids preserved). This one carries only what was chosen, and
   * leaves ids out of the matching path so it can land in someone else's
   * workspace, where the ids differ.
   */
  exportAccounts(input: {
    siteIds: string[];
    identityIds: string[];
    passphrase?: string;
    note?: string;
  }): { file: AccountBundleFile; counts: BundleCounts } {
    const wantedSites = new Set(input.siteIds);
    const wantedIdentities = new Set(input.identityIds);
    // An account selection implies its site, otherwise the account would have
    // nowhere to attach on the receiving side. An account with no site cannot be
    // exported: `buildAccountBundle` groups accounts by site, so it would be
    // dropped silently and the user would count accounts that never arrived.
    for (const identity of this.data.identities) {
      if (wantedIdentities.has(identity.id) && identity.siteId) wantedSites.add(identity.siteId);
    }
    const sites = this.data.sites.filter((site) => wantedSites.has(site.id));
    if (sites.length === 0) throw new Error("没有选择任何站点或账号");

    const identities = this.data.identities.filter(
      (identity) =>
        Boolean(identity.siteId) &&
        wantedSites.has(identity.siteId as string) &&
        (wantedIdentities.size === 0 || wantedIdentities.has(identity.id)),
    );

    let passwords: BundleSecrets | undefined;
    if (input.passphrase) {
      if (this.vault.locked) throw new Error(t("vault.locked"));
      passwords = { site: {}, identity: {} };
      for (const site of sites) {
        const password = this.vault.get({ kind: "site", id: site.id });
        if (password) passwords.site[site.baseUrl] = password;
      }
      for (const identity of identities) {
        const site = sites.find((item) => item.id === identity.siteId);
        if (!site) continue;
        const resolved = resolvePassword(
          this.vault,
          identity,
          identity.siteId,
          this.data.identities,
        );
        if (resolved.password) {
          passwords.identity[accountSecretKey(site.baseUrl, identity.username)] = resolved.password;
        }
      }
    }

    const file = buildAccountBundle({
      sites,
      identities,
      ...(passwords ? { passwords } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    // The plaintext never becomes part of the bundle object; only the sealed
    // blob is attached, and only after this point.
    if (input.passphrase && passwords) {
      const kdf = createKdfParams();
      file.secrets = {
        kdf,
        payload: seal(deriveKey(input.passphrase, kdf), JSON.stringify(passwords)),
      };
    }
    return { file, counts: accountBundleCounts(file) };
  }

  /**
   * Decrypts a bundle's password blob.
   *
   * Lives here rather than in `shared/` because the crypto helpers belong to the
   * core layer; the shared module only describes the format.
   */
  private openBundleSecrets(file: AccountBundleFile, passphrase: string): BundleSecrets {
    if (!file.secrets) return { site: {}, identity: {} };
    try {
      const parsed = JSON.parse(
        open(deriveKey(passphrase, file.secrets.kdf), file.secrets.payload),
      ) as { site?: Record<string, string>; identity?: Record<string, string> };
      return { site: parsed.site ?? {}, identity: parsed.identity ?? {} };
    } catch {
      throw new Error("口令不对，无法解开这个文件里的密码");
    }
  }

  /** What importing this bundle would touch, so the user can decide. */
  previewAccountBundle(file: AccountBundleFile): BundlePreview {
    const matchingSites = file.sites
      .filter((bundled) => this.data.sites.some((site) => site.baseUrl === bundled.baseUrl))
      .map((bundled) => bundled.name);
    return {
      ...accountBundleCounts(file),
      version: file.version,
      exportedAt: file.exportedAt,
      hasSecrets: Boolean(file.secrets),
      matchingSites,
    };
  }

  /**
   * Merges a bundle into this workspace.
   *
   * Sites are matched by base URL and accounts by username within the resolved
   * site: the sender's ids mean nothing here, and matching on them would either
   * overwrite an unrelated local account or create a duplicate of one.
   */
  importAccountBundle(file: AccountBundleFile, passphrase?: string): BundleImportResult {
    let secrets: BundleSecrets | undefined;
    if (file.secrets) {
      if (!passphrase) throw new Error(t("error.importNeedsPassphrase"));
      if (this.vault.locked) throw new Error(t("vault.locked"));
      secrets = this.openBundleSecrets(file, passphrase);
    }

    let sitesAdded = 0;
    let accountsAdded = 0;
    let accountsUpdated = 0;
    let passwordsWritten = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const bundled of file.sites) {
      let site = this.data.sites.find((item) => item.baseUrl === bundled.baseUrl);
      if (!site) {
        site = {
          id: randomUUID(),
          name: bundled.name,
          baseUrl: bundled.baseUrl,
          loginPath: bundled.loginPath,
          ...(bundled.authCheckPath ? { authCheckPath: bundled.authCheckPath } : {}),
          autoSubmit: bundled.autoSubmit,
          tagIds: [],
          createdAt: now,
          updatedAt: now,
        };
        this.data.sites.push(site);
        sitesAdded += 1;
      }
      const targetSite = site;
      const sitePassword = secrets?.site[bundled.baseUrl];
      if (bundled.hasPassword && sitePassword) {
        this.vault.set({ kind: "site", id: targetSite.id }, sitePassword);
        passwordsWritten += 1;
      }

      for (const account of bundled.accounts) {
        const secretKey = accountSecretKey(bundled.baseUrl, account.username);
        // Bundles written before sites stopped owning login fields carry them
        // here. They meant "every account on this site" then, so each account
        // gets them now unless it already sets the same label.
        const fields = [
          ...account.extraFields,
          ...bundled.extraFields.filter(
            (inherited) =>
              !account.extraFields.some(
                (own) => own.label.trim().toLowerCase() === inherited.label.trim().toLowerCase(),
              ),
          ),
        ].map((field) => ({ ...field }));
        const existing = this.data.identities.find(
          (item) =>
            item.siteId === targetSite.id &&
            item.username.trim().toLowerCase() === account.username.trim().toLowerCase(),
        );
        let identity: Identity;
        if (existing) {
          existing.name = account.name;
          existing.role = account.role;
          existing.color = account.color;
          existing.startPath = account.startPath;
          if (account.note) existing.note = account.note;
          existing.extraFields = fields;
          if (account.hasPassword) existing.passwordMode = "custom";
          existing.updatedAt = now;
          identity = existing;
          accountsUpdated += 1;
        } else {
          identity = {
            id: randomUUID(),
            siteId: targetSite.id,
            name: account.name,
            username: account.username,
            role: account.role,
            color: account.color,
            passwordMode: account.hasPassword ? "custom" : "inherit",
            status: "unknown",
            startPath: account.startPath,
            extraFields: fields,
            ...(account.note ? { note: account.note } : {}),
            createdAt: now,
            updatedAt: now,
          };
          this.data.identities.push(identity);
          accountsAdded += 1;
        }

        const password = secrets?.identity[secretKey];
        if (account.hasPassword && password) {
          this.vault.set({ kind: "identity", id: identity.id }, password);
          passwordsWritten += 1;
        } else if (account.hasPassword) {
          // The bundle says it has a password but none decrypted: say so instead
          // of silently saving an account that can never log in.
          skipped += 1;
        }
      }
    }

    this.persist();
    return {
      ...accountBundleCounts(file),
      sitesAdded,
      accountsAdded,
      accountsUpdated,
      skipped,
      passwordsWritten,
    };
  }

  // ---------- settings ----------

  saveSettings(patch: SettingsPatch): AppSettings {
    this.settings = { ...this.settings, ...patch };
    this.settingsStore.write(this.settings);
    this.emit();
    return this.settingsSnapshot();
  }

  // ---------- credentials ----------

  setPassword(owner: PasswordOwner, password: string): void {
    this.guardVaultUnlocked();
    this.vault.set(owner, password);
    this.persist();
  }

  clearPassword(owner: PasswordOwner): void {
    this.vault.clear(owner);
    this.persist();
  }

  copyPassword(owner: PasswordOwner): string | undefined {
    this.guardVaultUnlocked();
    return this.vault.get(owner);
  }

  /**
   * Password an identity would log in with, following references.
   *
   * Kept in the main process: the embedded login resolver needs the resolved value
   * but the renderer must never see it.
   */
  resolvedPassword(identityId: string): string | undefined {
    this.guardVaultUnlocked();
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) return undefined;
    return resolvePassword(this.vault, identity, identity.siteId, this.data.identities).password;
  }

  /**
   * The same lookup as {@link resolvedPassword}, plus why it failed.
   *
   * Used by the fill path: "no password" alone sends the user to the wrong
   * dialog when the account merely inherits a site default that was never set.
   */
  resolvePasswordDetail(identityId: string): {
    password?: string;
    source: "identity" | "site" | "missing";
    missing?: MissingCredentialReason;
  } {
    this.guardVaultUnlocked();
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) return { source: "missing", missing: "identity-empty" };
    return resolvePassword(this.vault, identity, identity.siteId, this.data.identities);
  }

  unlockVault(password: string): boolean {
    const unlocked = this.vault.unlock(password);
    this.emit();
    return unlocked;
  }

  lockVault(): void {
    this.vault.lock();
    this.emit();
  }

  setMasterPassword(password: string): void {
    if (password.length < 8) throw new Error(t("vault.masterTooShort"));
    if (!this.vault.secure) throw new Error(t("vault.unavailable"));
    this.vault.setMasterPassword(password);
    this.emit();
  }

  removeMasterPassword(): void {
    this.vault.removeMasterPassword();
    this.emit();
  }

  changeMasterPassword(current: string, next: string): boolean {
    if (next.length < 8) throw new Error(t("vault.masterTooShort"));
    const changed = this.vault.changeMasterPassword(current, next);
    this.emit();
    return changed;
  }

  private guardVaultUnlocked(): void {
    if (this.vault.locked) throw new VaultLockedError(t("vault.locked"));
  }

  // ---------- launching ----------

  private resolveEngine(identity: Identity): Engine {
    // An identity can still name its own browser — that is the escape hatch for
    // one account that genuinely needs a different version. Otherwise the single
    // global default decides, which is what the title bar's switch promises.
    const engineId = identity.engineId ?? this.settings.defaultEngineId;
    const engine =
      this.engines.find((item) => item.id === engineId) ?? this.defaultEngine();
    if (!engine) throw new Error(t("error.noEngine"));
    if (engine.status === "blocked")
      throw new Error(engine.blockReason ?? t("error.engineBlocked"));
    return engine;
  }

  /**
   * The browser an external launch uses when nothing more specific is asked for.
   *
   * Prefers an engine that speaks CDP: credential filling and session checks need
   * it, so a browser that cannot do those would launch into a session this app
   * cannot verify.
   */
  defaultEngine(): Engine | undefined {
    return this.engines.find((item) => item.cdp) ?? this.engines[0];
  }

  /**
   * Whether filling a site's login form should also press the button.
   *
   * Same shape as the engine default: one global answer, with a per-site escape
   * hatch. Resolved in one place so the external launcher, the embedded surface
   * and the MCP fill tool cannot disagree about it.
   */
  effectiveAutoSubmit(site: Pick<Site, "autoSubmit">): boolean {
    return site.autoSubmit ?? this.settings.autoSubmitLogin;
  }

  /**
   * The work area of the 主 window's display, in the same unit system the
   * browser uses for window bounds (Electron DIPs == Chromium CSS pixels on
   * Windows; verified at 150% scaling).
   *
   * Deliberately not `screen.avail*` from a browser page: that reports the
   * display the *browser window* happens to be on, and a launch that lands on a
   * secondary monitor would then lay out every slot with the wrong width.
   */
  private workArea(): Rect {
    return this.options.workArea?.() ?? { x: 0, y: 0, width: 1440, height: 900 };
  }

  /**
   * Learns the transparent window border once, from a window that is already
   * open. Before this runs, slots use the raw rectangles: the first window of a
   * session opens centred anyway, and the retile after this finishes corrects it.
   */
  private async learnFrameInset(instance: RunningInstance): Promise<void> {
    if (this.frameInset) return;
    if (instance.mode !== "cdp") return;
    try {
      this.frameInset = await measureFrameInset(instance.pid);
    } catch {
      // Unmeasurable frames are treated as zero: windows may keep a small gap,
      // which is cosmetic and never breaks placement.
    }
  }

  /** Bounds for one window under a preset; "no layout" means full work area. */
  private slotBounds(preset: LayoutPreset, area: Rect, index: number): Rect {
    if (isFreeLayout(preset)) return fullWorkArea(area);
    const rect = computeSlots(preset, area)[index] ?? fullWorkArea(area);
    // Windows insets the visible frame inside the bounds we set, so edge-to-edge
    // slots would still show a gap. Grow by the measured border to close it.
    return inflateRect(rect, this.frameInset);
  }

  /**
   * Prefers the user's drag-and-drop assignment, then the first free slot, and
   * finally wraps around when there are more members than slots.
   */
  private resolveSlotIndex(
    preset: LayoutPreset,
    identity: Identity,
    assignments: Record<string, number>,
    taken: Set<number>,
    fallback: number,
  ): number {
    if (isFreeLayout(preset)) return fallback;
    const wanted = assignments[identity.id];
    if (
      typeof wanted === "number" &&
      Number.isInteger(wanted) &&
      wanted >= 0 &&
      wanted < preset.slots.length &&
      !taken.has(wanted)
    ) {
      return wanted;
    }
    for (let index = 0; index < preset.slots.length; index += 1) {
      if (!taken.has(index)) return index;
    }
    return fallback % preset.slots.length;
  }

  /**
   * Picks a slot no other window of the same preset occupies yet. Overlapping a
   * newcomer on top of an existing window is worse than an uneven grid: the
   * user cannot tell which window they are looking at.
   */
  private firstFreeSlotIndex(preset: LayoutPreset): number {
    if (isFreeLayout(preset)) return 0;
    const taken = new Set<number>();
    for (const instance of this.liveInstances.values()) {
      if (instance.layoutId !== preset.id) continue;
      if (typeof instance.slotIndex === "number") taken.add(instance.slotIndex);
    }
    for (let index = 0; index < preset.slots.length; index += 1) {
      if (!taken.has(index)) return index;
    }
    return this.liveInstances.size % preset.slots.length;
  }

  /**
   * True when every window of this preset still sits exactly where the layout
   * put it. Windows the user has since moved, resized, maximized or minimized
   * count as theirs: opening one more window (or a clean session) must not
   * undo that work.
   */
  private async windowsUntouched(preset: LayoutPreset): Promise<boolean> {
    const candidates = [...this.liveInstances.values()].filter(
      (instance) =>
        instance.mode === "cdp" &&
        instance.targetId &&
        instance.layoutId === preset.id &&
        this.placedBounds.has(instance.id),
    );
    for (const instance of candidates) {
      const expected = this.placedBounds.get(instance.id);
      const entry = cdpRegistry.get(instance.id);
      if (!expected || !entry || !instance.targetId) continue;
      try {
        const info = await entry.browser.send<{
          bounds: {
            left: number;
            top: number;
            width: number;
            height: number;
            windowState?: string;
          };
        }>("Browser.getWindowForTarget", { targetId: instance.targetId });
        if (info.bounds.windowState && info.bounds.windowState !== "normal") return false;
        const moved =
          Math.abs(info.bounds.left - expected.x) > 2 ||
          Math.abs(info.bounds.top - expected.y) > 2 ||
          Math.abs(info.bounds.width - expected.width) > 2 ||
          Math.abs(info.bounds.height - expected.height) > 2;
        if (moved) return false;
      } catch {
        // A window that cannot be queried is most likely gone; leave it alone.
        return false;
      }
    }
    return true;
  }

  async launchIdentity(identityId: string, pathOverride?: string): Promise<LaunchResult> {
    // A second click while the first window is still connecting must not start a
    // second browser: Chromium would forward its URL into the first window as an
    // extra tab. Both callers share the one launch and get the same instance.
    const pending = this.pendingIdentityLaunches.get(identityId);
    if (pending) return pending;
    const job = this.launchIdentityNow(identityId, pathOverride);
    this.pendingIdentityLaunches.set(identityId, job);
    try {
      return await job;
    } finally {
      if (this.pendingIdentityLaunches.get(identityId) === job) {
        this.pendingIdentityLaunches.delete(identityId);
      }
    }
  }

  private async launchIdentityNow(
    identityId: string,
    pathOverride?: string,
  ): Promise<LaunchResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const site = this.data.sites.find((item) => item.id === identity.siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    const engine = this.resolveEngine(identity);

    const running = [...this.liveInstances.values()].find(
      (instance) => instance.identityId === identityId,
    );
    if (running) {
      return { instance: running, identities: [identity] };
    }

    const startUrl = joinUrl(
      site.baseUrl,
      pathOverride ?? identity.startPath ?? site.loginPath ?? "/",
    );
    const area = this.workArea();
    const preset = this.presetFor(this.settings.layout);
    const slotIndex = this.liveInstances.size === 0 ? 0 : this.firstFreeSlotIndex(preset);
    // The first window is the one being worked in, so it opens centered and
    // large; later windows follow the configured preset.
    const bounds =
      this.liveInstances.size === 0
        ? singleWindowRect(area)
        : this.slotBounds(preset, area, slotIndex);
    // Decide before opening anything: if the user already moved or resized one
    // of this layout's windows, adding another must leave all of them alone.
    const canRetile = await this.windowsUntouched(preset);

    const outcome = await launchBrowser({
      siteId: site.id,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: identity.id,
      startUrl,
      windowBounds: bounds,
      label: identity.name,
      identityId: identity.id,
      instanceId: randomUUID(),
    });
    outcome.instance.layoutId = preset.id;
    outcome.instance.slotIndex = slotIndex;

    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.watchInstance(outcome.instance, outcome.exited);
    this.persist();
    this.scheduleAutoFill(identity, site, outcome.instance);
    await this.learnFrameInset(outcome.instance);
    this.placedBounds.set(outcome.instance.id, bounds);
    if (canRetile) await this.tileInstances(preset, [...this.liveInstances.values()]);
    return { instance: outcome.instance, identities: [identity] };
  }

  async launchView(viewId: string): Promise<LaunchResult> {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) throw new Error(t("error.viewMissing"));

    const members = view.identityIds
      .map((id) => this.data.identities.find((identity) => identity.id === id))
      .filter((identity): identity is Identity => Boolean(identity));
    if (members.length === 0) throw new Error(t("error.viewMembers"));
    // A view may span sites: external windows are one window per identity, so
    // each one opens against its own site. The shared layout still holds,
    // because slot positions are screen coordinates, not per-site ones.
    const sites = new Map<string, Site>();
    for (const identity of members) {
      const memberSite = this.data.sites.find((item) => item.id === identity.siteId);
      if (!memberSite) throw new Error(t("error.siteMissing"));
      sites.set(memberSite.id, memberSite);
    }

    const result = await this.launchGroup(
      (identity) => {
        const site = identity.siteId ? sites.get(identity.siteId) : undefined;
        if (!site) throw new Error(t("error.siteMissing"));
        return site;
      },
      members,
      this.presetFor(view.layoutId),
      view.slotAssignments,
      (identity) => view.paths[identity.id],
    );
    // Remember the view for "restore on next start". Written only after every
    // window opened, so a half-failed launch never becomes the restore target.
    this.settings.lastViewId = view.id;
    this.settingsStore.write(this.settings);
    return result;
  }

  /**
   * Records a view as the restore target without launching anything.
   *
   * The built-in surface opens views itself, so it has to tell the workspace
   * which view was last used; otherwise "restore last view" would only ever
   * remember external launches.
   */
  rememberLaunchedView(viewId: string): void {
    if (!this.data.views.some((view) => view.id === viewId)) return;
    if (this.settings.lastViewId === viewId) return;
    this.settings.lastViewId = viewId;
    this.settingsStore.write(this.settings);
  }

  /**
   * Launches a hand-picked set of identities with the default layout.
   *
   * This is the identities page's batch action: the same tiling and the same
   * launch interval as a view, but the group is a selection rather than a saved
   * view, and nothing is remembered for restore-on-start. Starting them one by
   * one instead means every new window covers the cards you are still clicking.
   */
  async launchIdentities(identityIds: string[]): Promise<LaunchResult> {
    const wanted = new Set(identityIds.map(String));
    const members = this.data.identities.filter((identity) => wanted.has(identity.id));
    if (members.length === 0) throw new Error(t("error.viewMembers"));
    const siteId = members[0]?.siteId;
    // One layout describes one screen, so a batch spanning two sites would
    // have no sensible tiling; the UI only ever offers the active site.
    if (members.some((identity) => identity.siteId !== siteId)) {
      throw new Error(t("error.batchMixedSites"));
    }
    const site = this.data.sites.find((item) => item.id === siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    return this.launchGroup(
      () => site,
      members,
      this.presetFor(this.settings.layout),
      {},
      (identity) => identity.startPath,
    );
  }

  /**
   * Opens a set of windows into one layout.
   *
   * Already-running identities are reused rather than relaunched, and a failure
   * halfway rolls back only the windows this call opened, so the screen never
   * ends up with a half-applied layout.
   */
  private async launchGroup(
    siteFor: (identity: Identity) => Site,
    members: Identity[],
    preset: LayoutPreset,
    assignments: Record<string, number>,
    pathFor: (identity: Identity) => string | undefined,
  ): Promise<LaunchResult> {
    const area = this.workArea();
    const launched: RunningInstance[] = [];
    const startedHere: RunningInstance[] = [];
    const takenSlots = new Set<number>();
    const slotByInstance = new Map<string, number>();

    try {
      for (const [index, identity] of members.entries()) {
        const slotIndex = this.resolveSlotIndex(preset, identity, assignments, takenSlots, index);
        takenSlots.add(slotIndex);

        const running = [...this.liveInstances.values()].find(
          (instance) => instance.identityId === identity.id,
        );
        if (running) {
          launched.push(running);
          slotByInstance.set(running.id, slotIndex);
          running.layoutId = preset.id;
          running.slotIndex = slotIndex;
          continue;
        }
        // Each member opens against its own site, so a cross-site view gets the
        // right engine, base URL and default password per window.
        const site = siteFor(identity);
        const engine = this.resolveEngine(identity);
        const startUrl = joinUrl(
          site.baseUrl,
          pathFor(identity) ?? identity.startPath ?? site.loginPath ?? "/",
        );
        const outcome = await launchBrowser({
          siteId: site.id,
          profileRoot: this.options.profileRoot,
          engine,
          profileKey: identity.id,
          startUrl,
          windowBounds: this.slotBounds(preset, area, slotIndex),
          label: identity.name,
          identityId: identity.id,
          instanceId: randomUUID(),
        });
        outcome.instance.layoutId = preset.id;
        outcome.instance.slotIndex = slotIndex;
        this.liveInstances.set(outcome.instance.id, outcome.instance);
        this.watchInstance(outcome.instance, outcome.exited);
        launched.push(outcome.instance);
        startedHere.push(outcome.instance);
        slotByInstance.set(outcome.instance.id, slotIndex);
        this.scheduleAutoFill(identity, site, outcome.instance);
        // The first window of the session also tells us the real frame inset;
        // the retile at the end of the loop then applies it to every window.
        await this.learnFrameInset(outcome.instance);
        if (this.settings.launchIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.settings.launchIntervalMs));
        }
      }
    } catch (error) {
      // A group is all-or-nothing for the windows it opened itself, so a partial
      // failure does not leave a confusing half-launched ensemble behind.
      if (startedHere.length > 0) {
        await stopInstances(startedHere);
        for (const instance of startedHere) this.liveInstances.delete(instance.id);
        this.persist();
      }
      throw error;
    }

    this.persist();
    // Only this group's windows are rearranged; unrelated instances keep their
    // position, which matters when several groups run side by side.
    const groupInstances = launched.filter((instance) => this.liveInstances.has(instance.id));
    await this.tileInstances(preset, groupInstances, slotByInstance);
    return { instance: launched[0] as RunningInstance, identities: members };
  }

  /**
   * Reopens the view that was launched last, once per process. Callers should
   * have the window on screen already: this only starts browsers.
   */
  async restoreLastView(): Promise<ViewRestoreOutcome> {
    if (this.restoreAttempted) return { restored: false, reason: "already-attempted" };
    this.restoreAttempted = true;
    if (!this.settings.restoreLastView) return { restored: false, reason: "disabled" };

    const viewId = this.settings.lastViewId;
    if (!viewId) return { restored: false, reason: "no-view" };
    const view = this.data.views.find((item) => item.id === viewId);
    const site = view ? this.data.sites.find((item) => item.id === view.siteId) : undefined;
    if (!view || !site) {
      // The workspace changed while the app was closed. Drop the dangling id
      // instead of retrying it on every start.
      delete this.settings.lastViewId;
      this.settingsStore.write(this.settings);
      this.emit();
      return { restored: false, reason: "missing" };
    }

    // Engine scanning runs in the background; launching before it finishes can
    // pick no engine at all on a cold start with an empty cache.
    await this.maintenanceDone;
    try {
      await this.launchView(viewId);
      return { restored: true, viewId, viewName: view.name };
    } catch (error) {
      return {
        restored: false,
        viewId,
        viewName: view.name,
        reason: (error as Error).message,
      };
    }
  }

  /**
   * Reopens one member after the user closed its window. Without this the only
   * recovery was relaunching the whole view, which also restarted windows that
   * were still alive.
   */
  async launchViewMember(viewId: string, identityId: string): Promise<LaunchResult> {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) throw new Error(t("error.viewMissing"));
    const identity = this.data.identities.find(
      (item) => item.id === identityId && item.siteId === view.siteId,
    );
    if (!identity) throw new Error(t("error.identityMissing"));
    const site = this.data.sites.find((item) => item.id === view.siteId);
    if (!site) throw new Error(t("error.siteMissing"));

    const running = [...this.liveInstances.values()].find(
      (instance) => instance.identityId === identityId,
    );
    if (running) return { instance: running, identities: [identity] };

    const preset = this.presetFor(view.layoutId);
    const taken = new Set<number>();
    for (const memberId of view.identityIds) {
      if (memberId === identityId) continue;
      const instance = [...this.liveInstances.values()].find(
        (item) => item.identityId === memberId,
      );
      const assigned = view.slotAssignments[memberId];
      if (instance && typeof assigned === "number") taken.add(assigned);
    }
    const fallback = Math.max(0, view.identityIds.indexOf(identityId));
    const slotIndex = this.resolveSlotIndex(
      preset,
      identity,
      view.slotAssignments,
      taken,
      fallback,
    );

    const engine = this.resolveEngine(identity);
    const startUrl = joinUrl(
      site.baseUrl,
      view.paths[identity.id] ?? identity.startPath ?? site.loginPath ?? "/",
    );
    const bounds = this.slotBounds(preset, this.workArea(), slotIndex);
    const outcome = await launchBrowser({
      siteId: site.id,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: identity.id,
      startUrl,
      windowBounds: bounds,
      label: identity.name,
      identityId: identity.id,
      instanceId: randomUUID(),
    });
    outcome.instance.layoutId = preset.id;
    outcome.instance.slotIndex = slotIndex;
    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.watchInstance(outcome.instance, outcome.exited);
    this.persist();
    await this.learnFrameInset(outcome.instance);
    this.placedBounds.set(outcome.instance.id, bounds);
    this.scheduleAutoFill(identity, site, outcome.instance);
    return { instance: outcome.instance, identities: [identity] };
  }

  /**
   * Opens a disposable browser window. With an site it starts on that
   * login page; without one it opens a blank tab, for the cases where all the
   * user wants is a throwaway browser that belongs to no site at all.
   */
  async launchCleanSession(siteId?: string): Promise<LaunchResult> {
    // Reuse of a directory the startup sweep is about to delete must not happen.
    await this.maintenanceDone;
    const site = siteId ? this.data.sites.find((item) => item.id === siteId) : undefined;
    if (siteId && !site) throw new Error(t("error.siteMissing"));
    const engine = this.defaultEngine();
    if (!engine) throw new Error(t("error.noEngine"));

    const area = this.workArea();
    const preset = this.presetFor(this.settings.layout);
    const slotIndex = this.liveInstances.size === 0 ? 0 : this.firstFreeSlotIndex(preset);
    const slot =
      this.liveInstances.size === 0
        ? singleWindowRect(area)
        : this.slotBounds(preset, area, slotIndex);
    // Opening a throwaway window used to re-tile every other window, silently
    // undoing positions the user had just set by hand.
    const canRetile = await this.windowsUntouched(preset);
    const instanceId = randomUUID();

    const outcome = await launchBrowser({
      // Site-free sessions live in their own segment so deleting an
      // site can never adopt or stop them.
      siteId: site?.id ?? CLEAN_SESSION_SEGMENT,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: `${CLEAN_PROFILE_PREFIX}${instanceId}`,
      startUrl: site ? joinUrl(site.baseUrl, site.loginPath || "/") : "about:blank",
      windowBounds: slot,
      label: t("instance.cleanLabel"),
      instanceId,
      clean: true,
    });
    outcome.instance.layoutId = preset.id;
    outcome.instance.slotIndex = slotIndex;

    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.watchInstance(outcome.instance, outcome.exited);
    this.persist();
    await this.learnFrameInset(outcome.instance);
    this.placedBounds.set(outcome.instance.id, slot);
    if (canRetile) await this.tileInstances(preset, [...this.liveInstances.values()]);
    return { instance: outcome.instance, identities: [] };
  }

  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.liveInstances.get(instanceId);
    if (!instance) return;
    await stopInstances([instance]);
    await this.disposeCleanProfile(instance);
    this.liveInstances.delete(instanceId);
    this.placedBounds.delete(instanceId);
    this.persist();
  }

  async stopAll(): Promise<void> {
    const instances = [...this.liveInstances.values()];
    await stopInstances(instances);
    await Promise.all(instances.map((instance) => this.disposeCleanProfile(instance)));
    this.liveInstances.clear();
    this.placedBounds.clear();
    this.persist();
  }

  /**
   * Closes only the windows one view opened.
   *
   * Membership is the view's current identity list, not the instance's layout:
   * a window launched by hand for an identity that is also in the view is still
   * that identity's window, and the user asked for "this view's pages" to go
   * away. Instances started as part of another view are left alone.
   */
  async stopView(viewId: string): Promise<void> {
    const view = this.data.views.find((item) => item.id === viewId);
    if (!view) throw new Error(t("error.viewMissing"));
    const members = new Set(view.identityIds);
    // Clean sessions and blank windows carry no identity, so they can never be
    // part of a view; a missing id simply matches nothing.
    const instances = [...this.liveInstances.values()].filter(
      (instance) => instance.identityId !== undefined && members.has(instance.identityId),
    );
    if (instances.length === 0) return;
    await stopInstances(instances);
    await Promise.all(instances.map((instance) => this.disposeCleanProfile(instance)));
    for (const instance of instances) {
      this.liveInstances.delete(instance.id);
      this.placedBounds.delete(instance.id);
    }
    this.persist();
  }

  /**
   * Keeps the instance list honest when the browser goes away on its own —
   * the user closed the window, or the process crashed. Without this the UI
   * keeps offering "stop" for a browser that no longer exists.
   */
  private watchInstance(instance: RunningInstance, exited: Promise<void>): void {
    void exited.then(() => this.forgetExitedInstance(instance));
  }

  private async forgetExitedInstance(instance: RunningInstance): Promise<void> {
    // A stop triggered from the UI deletes the entry itself; this path must not
    // then resurrect, re-dispose or double-persist anything.
    if (!this.liveInstances.has(instance.id)) return;
    this.liveInstances.delete(instance.id);
    this.placedBounds.delete(instance.id);
    cdpRegistry.delete(instance.id);
    await this.disposeCleanProfile(instance);
    this.persist();
  }

  /**
   * Re-applies a preset to the windows it belongs to. Launching a second identity
   * used to leave the first one centered and overlapping the newcomer; tiling on
   * each launch keeps the layout matching what the picker promises. Failures are
   * ignored per window: Wayland compositors may refuse absolute placement, and a
   * window that moved nowhere is still usable.
   *
   * `slotByInstance` carries the slots resolved for a view: without it the index
   * of the launch order would silently overwrite drag-and-drop assignments.
   */
  private async tileInstances(
    preset: LayoutPreset,
    instances: RunningInstance[],
    slotByInstance?: Map<string, number>,
  ): Promise<void> {
    const movable = instances.filter(
      (instance) =>
        instance.mode === "cdp" &&
        instance.targetId &&
        (instance.layoutId === undefined || instance.layoutId === preset.id),
    );
    if (movable.length < 2) return;

    await Promise.all(
      movable.map(async (instance, index) => {
        const entry = cdpRegistry.get(instance.id);
        const targetId = instance.targetId;
        if (!entry || !targetId) return;
        const slotIndex = slotByInstance?.get(instance.id) ?? instance.slotIndex ?? index;
        const bounds = this.slotBounds(preset, this.workArea(), slotIndex);
        await setWindowBounds(entry.browser, targetId, bounds).catch(() => {});
        this.placedBounds.set(instance.id, bounds);
      }),
    );
  }

  /**
   * A clean session promises to leave nothing behind, so its profile directory is
   * dropped once the browser is gone. A locked file must not abort shutdown.
   *
   * `rm` retries with exponential backoff, so a generous maxRetries can block for
   * seconds when Chromium is still flushing. Bound the first attempt to roughly a
   * third of a second: the common case is still covered inline, and a directory
   * that stays locked moves to the background retry instead of stalling the
   * window close or being abandoned until the next startup sweep.
   */
  private async disposeCleanProfile(instance: RunningInstance): Promise<void> {
    if (!instance.clean) return;
    if (!isCleanProfileDir(instance.profileDir)) return;
    const dir = instance.profileDir;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      this.retryCleanProfile(dir);
    }
  }

  private retryCleanProfile(dir: string): void {
    if (this.cleanProfileRetries.has(dir)) return;
    const job = (async () => {
      // ~20s ceiling: a busy machine can take a while to flush Chromium's file
      // handles, and giving up early leaves the directory for the next startup
      // sweep. Short enough that a permanently stuck directory still falls
      // through to that sweep.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          // The browser may still be shutting down.
        }
      }
    })().finally(() => this.cleanProfileRetries.delete(dir));
    this.cleanProfileRetries.set(dir, job);
  }

  /**
   * Removes clean-session directories left behind by a crash or a forced kill.
   * Only runs at startup, before this process has launched any browser of its
   * own, so nothing here can belong to a live window.
   */
  private async sweepCleanProfiles(): Promise<void> {
    // Flatpak and Snap engines keep profiles outside profileRoot.
    const roots = [this.options.profileRoot];
    for (const engine of this.engines) {
      if (engine.profileBase) roots.push(engine.profileBase);
    }
    await removeCleanProfiles(roots);
  }

  private async reapOrphans(): Promise<void> {
    const owned = await findOwnedBrowserProcesses(this.options.profileRoot);
    for (const entry of owned) {
      try {
        if (process.platform === "win32") {
          const { execFile } = await import("node:child_process");
          execFile("taskkill", ["/PID", String(entry.pid), "/T", "/F"], () => {});
        } else {
          process.kill(entry.pid, "SIGKILL");
        }
      } catch {
        // The process may have exited between listing and killing.
      }
    }
  }

  // ---------- login state ----------

  private findInstance(identityId: string): RunningInstance | undefined {
    return [...this.liveInstances.values()].find((instance) => instance.identityId === identityId);
  }

  private requireSite(identity: Identity): Site {
    const site = this.data.sites.find((item) => item.id === identity.siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    return site;
  }

  async checkAuth(identityId: string): Promise<AuthCheckResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const { result, changed } = await this.runAuthCheck(identity);
    if (changed) this.persist();
    return result;
  }

  /**
   * Inspects one identity without persisting. Batch checks touch workspace.json
   * once at the end instead of once per identity, which matters for a view of
   * eight windows.
   */
  private async runAuthCheck(identity: Identity): Promise<{
    result: AuthCheckResult;
    changed: boolean;
  }> {
    const checkedAt = new Date().toISOString();
    const unknown = (detail: string): { result: AuthCheckResult; changed: boolean } => ({
      result: { identityId: identity.id, status: "unknown", checkedAt, detail },
      changed: false,
    });

    const site = this.data.sites.find((item) => item.id === identity.siteId);
    if (!site) return unknown(t("error.siteMissing"));
    const checkPath = site.authCheckPath;
    if (!checkPath) return unknown(t("auth.noCheckPath"));

    const instance = this.findInstance(identity.id);
    if (instance) {
      const entry = cdpRegistry.get(instance.id);
      if (!entry) return unknown(t("auth.noCdp"));
      return this.checkInOpenWindow(identity, site, checkPath, entry.page, checkedAt, unknown);
    }

    // No window: run the same check in a temporary headless session over this
    // identity's own profile. This is the case the feature exists for — the user
    // should not have to open eight windows to learn that two of them expired.
    if (this.options.headlessAuthCheck === false) return unknown(t("auth.notRunning"));
    return this.checkHeadless(identity, site, checkPath, checkedAt, unknown);
  }

  /** Reads the verdict from a page that is already open in a visible window. */
  private async checkInOpenWindow(
    identity: Identity,
    site: Site,
    checkPath: string,
    page: Parameters<typeof evaluate>[0],
    checkedAt: string,
    unknown: (detail: string) => { result: AuthCheckResult; changed: boolean },
  ): Promise<{ result: AuthCheckResult; changed: boolean }> {
    try {
      const location = await evaluate<string>(page, "location.href");
      if (!sameOrigin(location, site.baseUrl)) return unknown(t("auth.crossOrigin"));
      const result = await evaluate<{ status: number; ok: boolean; url: string; body?: string }>(
        page,
        buildAuthCheckExpression(checkPath),
        { awaitPromise: true },
      );
      return this.recordStatus(
        identity,
        checkedAt,
        result.status,
        bodyMarksSignedOut(result.body, site.authCheckSignedOut),
      );
    } catch (error) {
      return unknown((error as Error).message);
    }
  }

  /**
   * Opens a windowless session over the identity's profile, asks the check
   * endpoint, and closes it again. The window is never shown, so this works for
   * identities the user has not launched.
   */
  private async checkHeadless(
    identity: Identity,
    site: Site,
    checkPath: string,
    checkedAt: string,
    unknown: (detail: string) => { result: AuthCheckResult; changed: boolean },
  ): Promise<{ result: AuthCheckResult; changed: boolean }> {
    let engine: Engine;
    try {
      engine = this.resolveEngine(identity);
    } catch (error) {
      return unknown((error as Error).message);
    }
    if (!supportsHeadlessSession(engine))
      return unknown(t("auth.noHeadless", { brand: engine.brand }));

    const base = site.baseUrl.replace(/\/+$/, "");
    const startUrl = `${base}${checkPath}`;
    let session: HeadlessSession | undefined;
    try {
      session = await openHeadlessSession({
        engine,
        profileRoot: this.options.profileRoot,
        siteId: site.id,
        profileKey: identity.id,
        userAgent: this.settings.headlessCheckUa,
      });
      // The check runs on the site's own origin, so `credentials: include` sees
      // the profile's real cookies. Navigating first also makes a cross-origin
      // redirect visible instead of silently checking the wrong site.
      await navigateAndWait(session.page, startUrl, 15_000);
      const location = await evaluate<string>(session.page, "location.href");
      if (!sameOrigin(location, site.baseUrl)) return unknown(t("auth.crossOrigin"));
      const result = await evaluate<{ status: number; ok: boolean; url: string; body?: string }>(
        session.page,
        buildAuthCheckExpression(checkPath),
        { awaitPromise: true },
      );
      return this.recordStatus(
        identity,
        checkedAt,
        result.status,
        bodyMarksSignedOut(result.body, site.authCheckSignedOut),
      );
    } catch (error) {
      return unknown((error as Error).message);
    } finally {
      await session?.close();
    }
  }

  /** Stores one verdict and reports whether the workspace needs a save. */
  private recordStatus(
    identity: Identity,
    checkedAt: string,
    httpStatus: number,
    envelopeSignedOut = false,
  ): { result: AuthCheckResult; changed: boolean } {
    const signedIn = httpStatus >= 200 && httpStatus < 300 && !envelopeSignedOut;
    const status = signedIn ? "signed-in" : "expired";
    identity.status = status;
    identity.lastCheckedAt = checkedAt;
    identity.updatedAt = checkedAt;
    return {
      result: {
        identityId: identity.id,
        status,
        checkedAt,
        detail: `HTTP ${httpStatus}${envelopeSignedOut ? " + signed-out marker" : ""}`,
      },
      changed: true,
    };
  }

  /**
   * Runs the login check for one site (or every identity when omitted).
   * Three at a time: each identity owns a separate browser and CDP socket, so the
   * only shared resource is the page's own server.
   */
  async checkAllAuth(siteId?: string): Promise<AuthBatchResult> {
    const identities = this.data.identities.filter(
      (identity) => !siteId || identity.siteId === siteId,
    );
    const results: AuthCheckResult[] = new Array(identities.length);
    let cursor = 0;
    let changed = false;
    const workers = Math.min(3, identities.length);

    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= identities.length) return;
          const identity = identities[index] as Identity;
          const outcome = await this.runAuthCheck(identity);
          results[index] = outcome.result;
          if (outcome.changed) changed = true;
        }
      }),
    );

    if (changed) this.persist();
    const totals = { signedIn: 0, expired: 0, unknown: 0 };
    for (const result of results) {
      if (result.status === "signed-in") totals.signedIn += 1;
      else if (result.status === "expired") totals.expired += 1;
      else totals.unknown += 1;
    }
    return {
      ...(siteId ? { siteId } : {}),
      checkedAt: new Date().toISOString(),
      totals,
      results,
    };
  }

  /**
   * Opens the login page for every expired identity and fills the saved
   * credentials. Sequential on purpose: each launch opens a visible browser
   * window, and starting them together would both overwhelm the machine and make
   * failures impossible to attribute.
   */
  async reloginExpired(siteId?: string): Promise<ReloginBatchResult> {
    const targets = this.data.identities.filter(
      (identity) => (!siteId || identity.siteId === siteId) && identity.status === "expired",
    );
    const results: ReloginResult[] = [];
    for (const [index, identity] of targets.entries()) {
      if (index > 0 && this.settings.launchIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.settings.launchIntervalMs));
      }
      try {
        await this.fillLogin(identity.id);
        results.push({ identityId: identity.id, label: identity.name, ok: true });
      } catch (error) {
        results.push({
          identityId: identity.id,
          label: identity.name,
          ok: false,
          detail: (error as Error).message,
        });
      }
    }
    return {
      attempted: targets.length,
      succeeded: results.filter((result) => result.ok).length,
      results,
    };
  }

  /** Looks up the live instance owned by a browser process. */
  findInstanceByPid(pid: number): RunningInstance | undefined {
    return findInstanceByPid(this.liveInstances.values(), pid);
  }

  /**
   * Visible frame of an instance's window, used to place the transient identity
   * label. CDP knows the window it drives; external browsers are measured by the
   * OS helper instead.
   */
  async instanceWindowRect(instanceId: string): Promise<ScreenRect | undefined> {
    const instance = this.liveInstances.get(instanceId);
    if (!instance) return undefined;
    const entry = cdpRegistry.get(instanceId);
    if (entry && instance.targetId) {
      try {
        const info = await entry.browser.send<{
          bounds: {
            left: number;
            top: number;
            width: number;
            height: number;
            windowState?: string;
          };
        }>("Browser.getWindowForTarget", { targetId: instance.targetId });
        const { left, top, width, height, windowState } = info.bounds;
        if (windowState && windowState !== "normal") return undefined;
        if (width > 0 && height > 0) return { x: left, y: top, width, height };
      } catch {
        // Fall through to the OS measurement.
      }
    }
    return windowRectForPid(instance.pid);
  }

  /**
   * Raises a running browser window.
   *
   * CDP can only activate the tab, and window managers may ignore that while
   * another application owns the foreground — Windows refuses foreground
   * changes from background processes outright. The OS-level activation below
   * is what actually raises the window, and it also covers external-mode
   * browsers that have no CDP connection.
   */
  async focusInstance(instanceId: string): Promise<boolean> {
    const instance = this.liveInstances.get(instanceId);
    if (!instance) return false;
    const entry = cdpRegistry.get(instanceId);

    if (entry) {
      try {
        if (instance.targetId) {
          const info = await entry.browser
            .send<{ windowId: number; bounds: { windowState?: string } }>(
              "Browser.getWindowForTarget",
              { targetId: instance.targetId },
            )
            .catch(() => undefined);
          if (info?.bounds.windowState === "minimized") {
            await entry.browser
              .send("Browser.setWindowBounds", {
                windowId: info.windowId,
                bounds: { windowState: "normal" },
              })
              .catch(() => {});
          }
        }
        await entry.page.send("Page.bringToFront").catch(() => {});
      } catch {
        // Fall through to the platform activation below.
      }
    }

    if (await activateWindowForPid(instance.pid)) return true;
    // External windows and platforms without a focus helper still count as
    // "handled" when CDP did activate the tab.
    return Boolean(entry);
  }

  async fillLogin(identityId: string): Promise<AuthCheckResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const site = this.requireSite(identity);
    const resolved = resolvePassword(this.vault, identity, site.id, this.data.identities);
    if (!resolved.password) throw new Error(t("error.noPassword"));

    let instance = this.findInstance(identityId);
    if (!instance) {
      const result = await this.launchIdentity(identityId, site.loginPath);
      instance = result.instance;
    }
    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error(t("auth.noCdp"));

    const location = await evaluate<string>(entry.page, "location.href");
    if (!sameOrigin(location, site.baseUrl)) {
      throw new Error(t("auth.crossOrigin"));
    }
    if (!location.includes(site.loginPath)) {
      await navigateAndWait(entry.page, joinUrl(site.baseUrl, site.loginPath));
    }

    const outcome = await this.tryFill(identity, site, entry.page);
    if (!outcome.ok) {
      if (outcome.reason === "cross-origin") throw new Error(t("auth.crossOrigin"));
      if (outcome.reason === "origin-changed") throw new Error(t("auth.originChanged"));
      throw new Error(t("error.fillFailed", { reason: outcome.reason ?? "unknown" }));
    }

    const notes = [
      outcome.submitted ? t("auth.filledSubmitted") : t("auth.filled"),
      ...fillWarnings(outcome),
    ];
    return {
      identityId,
      status: "unknown",
      checkedAt: new Date().toISOString(),
      detail: notes.join(" · "),
    };
  }

  /**
   * Best-effort fill right after a window opens. The page may still be loading or
   * may redirect to a login form, so this polls briefly and never throws: a launch
   * must succeed even when there is nothing to fill.
   */
  private async autoFillAfterLaunch(
    identity: Identity,
    site: Site,
    instance: RunningInstance,
  ): Promise<AutoFillReport> {
    const base = {
      identityId: identity.id,
      label: identity.name,
      filled: false,
      submitted: false,
      missingFields: [] as string[],
      unmatchedFields: [] as string[],
    };
    const entry = cdpRegistry.get(instance.id);
    if (!entry) return { ...base, skipped: "external" };
    const resolution = resolvePassword(this.vault, identity, site.id, this.data.identities);
    if (!resolution.password) {
      return {
        ...base,
        skipped: "no-password",
        ...(resolution.missing ? { missingCredential: resolution.missing } : {}),
      };
    }

    // A window that is still painting a client-rendered login page can take a
    // few seconds on a loaded machine; giving up early reads as "autofill broke".
    const deadline = Date.now() + 15_000;
    let last: FillOutcome | undefined;
    let failed = false;
    while (Date.now() < deadline) {
      try {
        last = await this.tryFill(identity, site, entry.page);
        failed = false;
      } catch {
        // A navigation can destroy the execution context between two polls.
        // That is transient during startup, so retry until the deadline instead
        // of reporting a broken fill on the first hiccup.
        failed = true;
      }
      if (last?.ok || (last && last.reason !== "password-field-not-found")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (failed && !last) return { ...base, skipped: "failed" };
    if (!last?.ok) {
      // A form that never appears usually means the window opened already signed in.
      if (last?.reason === "cross-origin") return { ...base, skipped: "cross-origin" };
      if (last?.reason === "origin-changed") return { ...base, skipped: "origin-changed" };
      return { ...base, skipped: "not-login-page" };
    }
    return {
      ...base,
      filled: true,
      submitted: last.submitted,
      missingFields: last.missingExtra,
      unmatchedFields: last.unmatchedInputs,
    };
  }

  /** Shared fill path used by the explicit action and the post-launch attempt. */
  private async tryFill(
    identity: Identity,
    site: Site,
    page: Parameters<typeof evaluate>[0],
  ): Promise<FillOutcome> {
    const resolved = resolvePassword(this.vault, identity, site.id, this.data.identities);
    if (!resolved.password) {
      throw new Error(t("error.noPassword"));
    }
    // The page may have redirected to an SSO domain between the launch and now;
    // typing the password into a foreign origin would leak it to that site.
    const location = await evaluate<string>(page, "location.href");
    if (!sameOrigin(location, site.baseUrl)) {
      return {
        ok: false,
        reason: "cross-origin",
        filledUsername: false,
        submitted: false,
        filledExtra: [],
        missingExtra: [],
        unmatchedInputs: [],
      };
    }
    // The site's own address is editable, so "same origin as baseUrl" only proves
    // the page matches the *current* config. If the origin differs from the one
    // this site last used, the address itself was changed — refuse until the user
    // confirms, otherwise a quiet edit would redirect the password elsewhere.
    const expected = site.lastOrigin;
    const currentOrigin = new URL(site.baseUrl).origin;
    if (expected && expected !== currentOrigin) {
      this.pendingOriginConfirmation = {
        identityId: identity.id,
        siteId: site.id,
        siteName: site.name,
        expectedOrigin: expected,
        currentOrigin,
      };
      return {
        ok: false,
        reason: "origin-changed",
        filledUsername: false,
        submitted: false,
        filledExtra: [],
        missingExtra: [],
        unmatchedInputs: [],
      };
    }
    this.recordSiteOrigin(site, currentOrigin);
    return evaluate<FillOutcome>(
      page,
      buildFillExpression({
        username: identity.username,
        password: resolved.password,
        submit: this.effectiveAutoSubmit(site),
        extraFields: resolveLoginFields(identity),
      }),
    );
  }

  /** Records the origin a site just authenticated against. */
  private recordSiteOrigin(site: Site, origin: string): void {
    if (site.lastOrigin === origin) return;
    site.lastOrigin = origin;
    this.persist();
  }

  /**
   * The origin mismatch that blocked the last fill, if any.
   *
   * The UI reads this to show "the address changed" and, once the user accepts,
   * calls {@link acceptSiteOrigin} before retrying.
   */
  takeOriginNotice(): OriginChangedNotice | undefined {
    const notice = this.pendingOriginConfirmation;
    this.pendingOriginConfirmation = undefined;
    return notice;
  }

  /** Accepts the current address and records it as the site's trusted origin. */
  acceptSiteOrigin(siteId: string): void {
    const site = this.data.sites.find((item) => item.id === siteId);
    if (!site) throw new Error(t("error.siteMissing"));
    this.recordSiteOrigin(site, new URL(site.baseUrl).origin);
  }

  /**
   * Runs the post-launch fill off the critical path: a view of four windows must
   * not wait eight seconds per identity before the UI reports success.
   */
  private scheduleAutoFill(identity: Identity, site: Site, instance: RunningInstance): void {
    if (!this.settings.autoFillOnLaunch) return;
    void this.autoFillAfterLaunch(identity, site, instance)
      .then((report) => this.options.onAutoFill?.(report))
      .catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.stopAll();
  }

  // ---------- read helpers for the UI ----------

  findIdentity(id: string): Identity | undefined {
    return this.data.identities.find((item) => item.id === id);
  }

  findSite(id: string | undefined): Site | undefined {
    if (!id) return undefined;
    return this.data.sites.find((item) => item.id === id);
  }

  /**
   * Site whose address matches a page origin, for saving a login seen in the
   * wild. The longest matching base URL wins, so a site mounted under a
   * sub-path beats a site that only shares the origin.
   */
  findSiteByOrigin(origin: string): Site | undefined {
    let best: { site: Site; length: number } | undefined;
    for (const site of this.data.sites) {
      let siteOrigin: string;
      try {
        siteOrigin = new URL(site.baseUrl).origin;
      } catch {
        continue;
      }
      if (siteOrigin !== origin) continue;
      const length = site.baseUrl.length;
      if (!best || length > best.length) best = { site, length };
    }
    return best?.site;
  }

  /**
   * Whether the vault already holds the login for this username on this site.
   *
   * Used to keep the "save this login?" prompt for credentials the vault does
   * not have yet: signing in as an account that is already saved would only
   * offer a duplicate. An identity saved without a password does not count —
   * that is exactly the case worth capturing.
   */
  hasSavedLogin(siteId: string, username: string): boolean {
    const needle = username.trim().toLowerCase();
    if (!needle) return false;
    const identity = this.data.identities.find(
      (item) => item.siteId === siteId && item.username.trim().toLowerCase() === needle,
    );
    if (!identity) return false;
    try {
      return Boolean(resolvePassword(this.vault, identity, siteId, this.data.identities).password);
    } catch {
      // A locked vault cannot tell; prompting is the safer side of that doubt.
      return false;
    }
  }

  findView(id: string): View | undefined {
    return this.data.views.find((item) => item.id === id);
  }

  profileDirFor(identityId: string): string | undefined {
    const instance = this.findInstance(identityId);
    if (instance) return instance.profileDir;
    const identity = this.findIdentity(identityId);
    if (!identity) return undefined;
    // An account with no site has no profile directory: `<root>/undefined/<id>`
    // is not a place anything was ever launched from.
    if (!identity.siteId) return undefined;
    return join(this.options.profileRoot, identity.siteId, identity.id);
  }

  profileDirExists(identityId: string): boolean {
    const dir = this.profileDirFor(identityId);
    return dir ? existsSync(dir) : false;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Canonical comparison key for a bookmark URL; unreadable input compares as itself. */
function canonicalBookmarkUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

/** Three decimals is plenty for a 4K screen and keeps stored presets readable. */
function roundFraction(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Drops rows the UI may have left empty while the user was editing. */
function sanitizeLoginFields(fields: LoginField[] | undefined): LoginField[] | undefined {
  const cleaned = (fields ?? [])
    .map((field) => ({ label: field.label.trim(), value: field.value.trim() }))
    .filter((field) => field.label);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Human readable notes about fields the fill could not place. */
function fillWarnings(outcome: FillOutcome): string[] {
  const notes: string[] = [];
  if (outcome.missingExtra.length > 0) {
    notes.push(t("auth.missingFields", { fields: outcome.missingExtra.join("、") }));
  }
  if (outcome.unmatchedInputs.length > 0) {
    notes.push(t("auth.unmatchedFields", { fields: outcome.unmatchedInputs.join("、") }));
  }
  return notes;
}
