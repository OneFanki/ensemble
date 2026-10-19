import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import type {
  AppSettings,
  AuthCheckResult,
  AutoFillReport,
  CredentialPresence,
  Engine,
  Environment,
  EnvironmentDraft,
  Identity,
  IdentityDraft,
  LaunchResult,
  LayoutKey,
  LoginField,
  PasswordOwner,
  Platform,
  RunningInstance,
  Scene,
  SceneDraft,
  SettingsPatch,
  WorkspaceSnapshot,
} from "@shared/types";
import { evaluate, navigateAndWait, setWindowBounds } from "./cdp/browser";
import { buildAuthCheckExpression, buildFillExpression, type FillOutcome } from "./cdp/login";
import {
  CredentialVault,
  resolvePassword,
  VaultLockedError,
  type SecretBox,
  type VaultFile,
} from "./credentials/vault";
import { mergeManualEngines, scanEngines } from "./engines";
import { t } from "./i18n/translate";
import { cdpRegistry, launchBrowser, stopInstances } from "./launch/browser";
import { computeGrid, singleWindowRect, slotCount, type Rect } from "./layout/grid";
import { resolveLoginFields } from "./login-fields";
import {
  CLEAN_PROFILE_PREFIX,
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
import { JsonStore } from "./storage/json-store";
import { joinUrl, sameOrigin } from "./util/url";

export interface WorkspaceServiceOptions {
  userDataDir: string;
  profileRoot: string;
  platform: Platform;
  secretBox: SecretBox;
  appVersion: string;
  /** Returns the current window work area, injected by Electron so core stays UI free. */
  workArea?: () => Rect;
  onChange?: () => void;
  /** Reports the outcome of a best-effort fill that ran after a window opened. */
  onAutoFill?: (report: AutoFillReport) => void;
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
  /** Resolves once startup cleanup finished; clean sessions wait on it. */
  private maintenanceDone: Promise<void> = Promise.resolve();
  private readonly liveInstances = new Map<string, RunningInstance>();

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
      environment: {},
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
      environments: this.data.environments,
      identities: this.data.identities,
      scenes: this.data.scenes,
      engines: this.engines,
      enginesReady: this.enginesReady,
      instances: [...this.liveInstances.values()],
      settings: this.settingsSnapshot(),
      credentials: this.credentialPresence(),
      platform: this.options.platform,
      appVersion: this.options.appVersion,
      userDataDir: this.options.userDataDir,
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
      environment: presence.environment,
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

  // ---------- environments ----------

  saveEnvironment(draft: EnvironmentDraft): Environment {
    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.data.environments.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.environmentMissing"));
      Object.assign(existing, {
        name: draft.name,
        baseUrl: trimTrailingSlash(draft.baseUrl),
        loginPath: draft.loginPath,
        authCheckPath: draft.authCheckPath,
        kind: draft.kind,
        defaultEngineId: draft.defaultEngineId,
        autoSubmit: draft.autoSubmit,
        extraFields: sanitizeLoginFields(draft.extraFields),
        updatedAt: now,
      });
      this.persist();
      return existing;
    }

    const environment: Environment = {
      id: randomUUID(),
      name: draft.name,
      baseUrl: trimTrailingSlash(draft.baseUrl),
      loginPath: draft.loginPath,
      authCheckPath: draft.authCheckPath,
      kind: draft.kind,
      defaultEngineId: draft.defaultEngineId,
      autoSubmit: draft.autoSubmit,
      extraFields: sanitizeLoginFields(draft.extraFields),
      createdAt: now,
      updatedAt: now,
    };
    this.data.environments.push(environment);
    this.persist();
    return environment;
  }

  deleteEnvironment(id: string): void {
    const identityIds = this.data.identities
      .filter((identity) => identity.environmentId === id)
      .map((identity) => identity.id);
    for (const instance of [...this.liveInstances.values()]) {
      if (instance.environmentId === id) {
        void this.stopInstance(instance.id);
      }
    }
    this.data.environments = this.data.environments.filter((item) => item.id !== id);
    this.data.identities = this.data.identities.filter((item) => item.environmentId !== id);
    this.data.scenes = this.data.scenes.filter((item) => item.environmentId !== id);
    for (const identityId of identityIds) {
      this.vault.clear({ kind: "identity", id: identityId });
    }
    this.vault.clearEnvironment(id);
    this.persist();
  }

  // ---------- identities ----------

  saveIdentity(draft: IdentityDraft, password?: string): Identity {
    const environment = this.data.environments.find((item) => item.id === draft.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    const now = new Date().toISOString();

    let identity: Identity;
    if (draft.id) {
      const existing = this.data.identities.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.identityMissing"));
      Object.assign(existing, {
        name: draft.name,
        username: draft.username,
        role: draft.role,
        color: draft.color,
        engineId: draft.engineId,
        startPath: draft.startPath,
        passwordMode: draft.passwordMode,
        extraFields: sanitizeLoginFields(draft.extraFields),
        note: draft.note,
        updatedAt: now,
      });
      identity = existing;
    } else {
      identity = {
        id: randomUUID(),
        environmentId: draft.environmentId,
        name: draft.name,
        username: draft.username,
        role: draft.role,
        color: draft.color,
        engineId: draft.engineId,
        startPath: draft.startPath,
        passwordMode: draft.passwordMode,
        extraFields: sanitizeLoginFields(draft.extraFields),
        note: draft.note,
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
    this.persist();
    return identity;
  }

  deleteIdentity(id: string): void {
    for (const instance of [...this.liveInstances.values()]) {
      if (instance.identityId === id) void this.stopInstance(instance.id);
    }
    this.data.identities = this.data.identities.filter((item) => item.id !== id);
    for (const scene of this.data.scenes) {
      scene.identityIds = scene.identityIds.filter((identityId) => identityId !== id);
      delete scene.paths[id];
    }
    this.data.scenes = this.data.scenes.filter((scene) => scene.identityIds.length > 0);
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

    const dir = join(this.options.profileRoot, identity.environmentId, identity.id);
    await rm(dir, { recursive: true, force: true });

    identity.status = "unknown";
    identity.lastCheckedAt = undefined;
    identity.updatedAt = new Date().toISOString();
    this.persist();
  }

  // ---------- scenes ----------

  saveScene(draft: SceneDraft): Scene {
    const environment = this.data.environments.find((item) => item.id === draft.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    const known = new Set(
      this.data.identities
        .filter((identity) => identity.environmentId === draft.environmentId)
        .map((identity) => identity.id),
    );
    const identityIds = draft.identityIds.filter((id) => known.has(id));
    if (identityIds.length === 0) throw new Error(t("error.sceneMembers"));

    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.data.scenes.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.sceneMissing"));
      Object.assign(existing, {
        name: draft.name,
        identityIds,
        layout: draft.layout,
        paths: draft.paths,
        updatedAt: now,
      });
      this.persist();
      return existing;
    }

    const scene: Scene = {
      id: randomUUID(),
      environmentId: draft.environmentId,
      name: draft.name,
      identityIds,
      layout: draft.layout,
      paths: draft.paths,
      createdAt: now,
      updatedAt: now,
    };
    this.data.scenes.push(scene);
    this.persist();
    return scene;
  }

  deleteScene(id: string): void {
    this.data.scenes = this.data.scenes.filter((item) => item.id !== id);
    this.persist();
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

  private resolveEngine(identity: Identity, environment: Environment): Engine {
    const engineId = identity.engineId ?? environment.defaultEngineId;
    const engine =
      this.engines.find((item) => item.id === engineId) ?? this.engines.find((item) => item.cdp);
    if (!engine) throw new Error(t("error.noEngine"));
    if (engine.status === "blocked")
      throw new Error(engine.blockReason ?? t("error.engineBlocked"));
    return engine;
  }

  private workArea(): Rect {
    return this.options.workArea?.() ?? { x: 0, y: 0, width: 1440, height: 900 };
  }

  async launchIdentity(identityId: string, pathOverride?: string): Promise<LaunchResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const environment = this.data.environments.find((item) => item.id === identity.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    const engine = this.resolveEngine(identity, environment);

    const running = [...this.liveInstances.values()].find(
      (instance) => instance.identityId === identityId,
    );
    if (running) {
      return { instance: running, identities: [identity] };
    }

    const startUrl = joinUrl(
      environment.baseUrl,
      pathOverride ?? identity.startPath ?? environment.loginPath ?? "/",
    );
    const area = this.workArea();
    // The first window is the one being worked in, so it opens centered and
    // large; later windows tile into the remaining grid slots.
    const slot =
      this.liveInstances.size === 0
        ? singleWindowRect(area)
        : computeGrid(this.settings.layout, area)[
            this.liveInstances.size % slotCount(this.settings.layout)
          ];

    const outcome = await launchBrowser({
      environmentId: environment.id,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: identity.id,
      startUrl,
      windowBounds: slot,
      label: identity.name,
      identityId: identity.id,
      instanceId: randomUUID(),
    });

    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.watchInstance(outcome.instance, outcome.exited);
    this.persist();
    this.scheduleAutoFill(identity, environment, outcome.instance);
    await this.tileInstances(this.settings.layout);
    return { instance: outcome.instance, identities: [identity] };
  }

  async launchScene(sceneId: string): Promise<LaunchResult> {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error(t("error.sceneMissing"));
    const environment = this.data.environments.find((item) => item.id === scene.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));

    const members = scene.identityIds
      .map((id) => this.data.identities.find((identity) => identity.id === id))
      .filter((identity): identity is Identity => Boolean(identity));
    if (members.length === 0) throw new Error(t("error.sceneMembers"));

    const area = this.workArea();
    const slots = computeGrid(scene.layout as LayoutKey, area);
    const launched: RunningInstance[] = [];
    const startedHere: RunningInstance[] = [];

    try {
      for (const [index, identity] of members.entries()) {
        const running = [...this.liveInstances.values()].find(
          (instance) => instance.identityId === identity.id,
        );
        if (running) {
          launched.push(running);
          continue;
        }
        const engine = this.resolveEngine(identity, environment);
        const startUrl = joinUrl(
          environment.baseUrl,
          scene.paths[identity.id] ?? identity.startPath ?? environment.loginPath ?? "/",
        );
        const outcome = await launchBrowser({
          environmentId: environment.id,
          profileRoot: this.options.profileRoot,
          engine,
          profileKey: identity.id,
          startUrl,
          windowBounds: slots[index % slots.length],
          label: identity.name,
          identityId: identity.id,
          instanceId: randomUUID(),
        });
        this.liveInstances.set(outcome.instance.id, outcome.instance);
        this.watchInstance(outcome.instance, outcome.exited);
        launched.push(outcome.instance);
        startedHere.push(outcome.instance);
        this.scheduleAutoFill(identity, environment, outcome.instance);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (error) {
      // A scene is all-or-nothing for the windows it opened itself, so a partial
      // failure does not leave a confusing half-launched ensemble behind.
      if (startedHere.length > 0) {
        await stopInstances(startedHere);
        for (const instance of startedHere) this.liveInstances.delete(instance.id);
        this.persist();
      }
      throw error;
    }

    this.persist();
    await this.tileInstances(scene.layout as LayoutKey);
    return { instance: launched[0] as RunningInstance, identities: members };
  }

  async launchCleanSession(environmentId: string): Promise<LaunchResult> {
    // Reuse of a directory the startup sweep is about to delete must not happen.
    await this.maintenanceDone;
    const environment = this.data.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    const engine =
      this.engines.find((item) => item.id === environment.defaultEngineId) ??
      this.engines.find((item) => item.cdp);
    if (!engine) throw new Error(t("error.noEngine"));

    const area = this.workArea();
    const slot =
      this.liveInstances.size === 0
        ? singleWindowRect(area)
        : computeGrid(this.settings.layout, area)[
            this.liveInstances.size % slotCount(this.settings.layout)
          ];
    const instanceId = randomUUID();

    const outcome = await launchBrowser({
      environmentId: environment.id,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: `${CLEAN_PROFILE_PREFIX}${instanceId}`,
      startUrl: joinUrl(environment.baseUrl, environment.loginPath || "/"),
      windowBounds: slot,
      label: t("instance.cleanLabel"),
      instanceId,
      clean: true,
    });

    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.watchInstance(outcome.instance, outcome.exited);
    this.persist();
    await this.tileInstances(this.settings.layout);
    return { instance: outcome.instance, identities: [] };
  }

  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.liveInstances.get(instanceId);
    if (!instance) return;
    await stopInstances([instance]);
    await this.disposeCleanProfile(instance);
    this.liveInstances.delete(instanceId);
    this.persist();
  }

  async stopAll(): Promise<void> {
    const instances = [...this.liveInstances.values()];
    await stopInstances(instances);
    await Promise.all(instances.map((instance) => this.disposeCleanProfile(instance)));
    this.liveInstances.clear();
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
    cdpRegistry.delete(instance.id);
    await this.disposeCleanProfile(instance);
    this.persist();
  }

  /**
   * Re-applies a grid to every window that is already open. Launching a second
   * identity used to leave the first one centered and overlapping the newcomer;
   * tiling on each launch keeps the layout matching what the picker promises.
   * Failures are ignored per window: Wayland compositors may refuse absolute
   * placement, and a window that moved nowhere is still usable.
   */
  private async tileInstances(layout: LayoutKey): Promise<void> {
    const instances = [...this.liveInstances.values()].filter(
      (instance) => instance.mode === "cdp" && instance.targetId,
    );
    if (instances.length < 2) return;

    const slots = computeGrid(layout, this.workArea());
    await Promise.all(
      instances.map(async (instance, index) => {
        const entry = cdpRegistry.get(instance.id);
        const targetId = instance.targetId;
        if (!entry || !targetId) return;
        const slot = slots[index % slots.length];
        if (!slot) return;
        await setWindowBounds(entry.browser, targetId, slot).catch(() => {});
      }),
    );
  }

  /**
   * A clean session promises to leave nothing behind, so its profile directory is
   * dropped once the browser is gone. A locked file must not abort shutdown.
   */
  private async disposeCleanProfile(instance: RunningInstance): Promise<void> {
    if (!instance.clean) return;
    if (!isCleanProfileDir(instance.profileDir)) return;
    try {
      await rm(instance.profileDir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
    } catch {
      // A file still held by the exiting browser is reclaimed by the next sweep.
    }
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

  private requireEnvironment(identity: Identity): Environment {
    const environment = this.data.environments.find((item) => item.id === identity.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    return environment;
  }

  async checkAuth(identityId: string): Promise<AuthCheckResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const environment = this.requireEnvironment(identity);
    const instance = this.findInstance(identityId);
    const checkedAt = new Date().toISOString();

    if (!environment.authCheckPath) {
      return { identityId, status: "unknown", checkedAt, detail: t("auth.noCheckPath") };
    }
    if (!instance) {
      return { identityId, status: "unknown", checkedAt, detail: t("auth.notRunning") };
    }
    const entry = cdpRegistry.get(instance.id);
    if (!entry) {
      return { identityId, status: "unknown", checkedAt, detail: t("auth.noCdp") };
    }

    try {
      const location = await evaluate<string>(entry.page, "location.href");
      if (!sameOrigin(location, environment.baseUrl)) {
        return { identityId, status: "unknown", checkedAt, detail: t("auth.crossOrigin") };
      }
      const result = await evaluate<{ status: number; ok: boolean; url: string }>(
        entry.page,
        buildAuthCheckExpression(environment.authCheckPath),
        { awaitPromise: true },
      );
      const signedIn = result.status >= 200 && result.status < 300;
      const status = signedIn ? "signed-in" : "expired";
      identity.status = status;
      identity.lastCheckedAt = checkedAt;
      identity.updatedAt = checkedAt;
      this.persist();
      return { identityId, status, checkedAt, detail: `HTTP ${result.status}` };
    } catch (error) {
      return {
        identityId,
        status: "unknown",
        checkedAt,
        detail: (error as Error).message,
      };
    }
  }

  async fillLogin(identityId: string): Promise<AuthCheckResult> {
    const identity = this.data.identities.find((item) => item.id === identityId);
    if (!identity) throw new Error(t("error.identityMissing"));
    const environment = this.requireEnvironment(identity);
    const resolved = resolvePassword(this.vault, identity, environment.id);
    if (!resolved.password) throw new Error(t("error.noPassword"));

    let instance = this.findInstance(identityId);
    if (!instance) {
      const result = await this.launchIdentity(identityId, environment.loginPath);
      instance = result.instance;
    }
    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error(t("auth.noCdp"));

    const location = await evaluate<string>(entry.page, "location.href");
    if (!sameOrigin(location, environment.baseUrl)) {
      throw new Error(t("auth.crossOrigin"));
    }
    if (!location.includes(environment.loginPath)) {
      await navigateAndWait(entry.page, joinUrl(environment.baseUrl, environment.loginPath));
    }

    const outcome = await this.tryFill(identity, environment, entry.page);
    if (!outcome.ok) {
      if (outcome.reason === "cross-origin") throw new Error(t("auth.crossOrigin"));
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
    environment: Environment,
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
    if (!resolvePassword(this.vault, identity, environment.id).password) {
      return { ...base, skipped: "no-password" };
    }

    // A window that is still painting a client-rendered login page can take a
    // few seconds on a loaded machine; giving up early reads as "autofill broke".
    const deadline = Date.now() + 15_000;
    let last: FillOutcome | undefined;
    while (Date.now() < deadline) {
      try {
        last = await this.tryFill(identity, environment, entry.page);
      } catch {
        return { ...base, skipped: "failed" };
      }
      if (last.ok || last.reason !== "password-field-not-found") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!last?.ok) {
      // A form that never appears usually means the window opened already signed in.
      if (last?.reason === "cross-origin") return { ...base, skipped: "cross-origin" };
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
    environment: Environment,
    page: Parameters<typeof evaluate>[0],
  ): Promise<FillOutcome> {
    const resolved = resolvePassword(this.vault, identity, environment.id);
    if (!resolved.password) {
      throw new Error(t("error.noPassword"));
    }
    // The page may have redirected to an SSO domain between the launch and now;
    // typing the password into a foreign origin would leak it to that site.
    const location = await evaluate<string>(page, "location.href");
    if (!sameOrigin(location, environment.baseUrl)) {
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
    return evaluate<FillOutcome>(
      page,
      buildFillExpression({
        username: identity.username,
        password: resolved.password,
        submit: environment.autoSubmit,
        extraFields: resolveLoginFields(environment, identity),
      }),
    );
  }

  /**
   * Runs the post-launch fill off the critical path: a scene of four windows must
   * not wait eight seconds per identity before the UI reports success.
   */
  private scheduleAutoFill(
    identity: Identity,
    environment: Environment,
    instance: RunningInstance,
  ): void {
    if (!this.settings.autoFillOnLaunch) return;
    void this.autoFillAfterLaunch(identity, environment, instance)
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

  profileDirFor(identityId: string): string | undefined {
    const instance = this.findInstance(identityId);
    if (instance) return instance.profileDir;
    const identity = this.findIdentity(identityId);
    if (!identity) return undefined;
    return join(this.options.profileRoot, identity.environmentId, identity.id);
  }

  profileDirExists(identityId: string): boolean {
    const dir = this.profileDirFor(identityId);
    return dir ? existsSync(dir) : false;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
