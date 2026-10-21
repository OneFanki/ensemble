import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@shared/defaults";
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
  CredentialPresence,
  Engine,
  Environment,
  EnvironmentDraft,
  Identity,
  IdentityDraft,
  LaunchResult,
  LayoutId,
  LayoutPreset,
  LayoutPresetDraft,
  LoginField,
  PasswordOwner,
  Platform,
  ReloginBatchResult,
  ReloginResult,
  RunningInstance,
  Scene,
  SceneDraft,
  SceneRestoreOutcome,
  SettingsPatch,
  WorkspaceSnapshot,
} from "@shared/types";
import { evaluate, navigateAndWait, setWindowBounds } from "./cdp/browser";
import { buildAuthCheckExpression, buildFillExpression, type FillOutcome } from "./cdp/login";
import { createKdfParams, deriveKey, open, seal } from "./credentials/crypto";
import {
  CredentialVault,
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
  openHeadlessSession,
  supportsHeadlessSession,
  type HeadlessSession,
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
      layoutPresets: this.data.layoutPresets,
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
    const removedSceneIds = new Set(
      this.data.scenes.filter((scene) => scene.environmentId === id).map((scene) => scene.id),
    );
    this.data.environments = this.data.environments.filter((item) => item.id !== id);
    this.data.identities = this.data.identities.filter((item) => item.environmentId !== id);
    this.data.scenes = this.data.scenes.filter((item) => item.environmentId !== id);
    for (const identityId of identityIds) {
      this.vault.clear({ kind: "identity", id: identityId });
    }
    this.vault.clearEnvironment(id);
    if (this.settings.lastSceneId && removedSceneIds.has(this.settings.lastSceneId)) {
      delete this.settings.lastSceneId;
      this.settingsStore.write(this.settings);
    }
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
      delete scene.slotAssignments[id];
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

  private presetFor(layoutId: LayoutId): LayoutPreset {
    return findLayout(layoutId, this.data.layoutPresets);
  }

  /**
   * Keeps assignments honest: only member ids survive, and only slot indices that
   * exist in the referenced preset. Missing entries are filled at launch time in
   * member order, so an old scene without assignments still opens sensibly.
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

    const layout = this.presetFor(draft.layoutId);
    const slotAssignments = this.sanitizeAssignments(layout, identityIds, draft.slotAssignments);
    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.data.scenes.find((item) => item.id === draft.id);
      if (!existing) throw new Error(t("error.sceneMissing"));
      Object.assign(existing, {
        name: draft.name,
        identityIds,
        layoutId: layout.id,
        slotAssignments,
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
      layoutId: layout.id,
      slotAssignments,
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
    if (this.settings.lastSceneId === id) {
      delete this.settings.lastSceneId;
      this.settingsStore.write(this.settings);
    }
    this.persist();
  }

  /** Switching the preset clears assignments that no longer point at a real slot. */
  setSceneLayout(sceneId: string, layoutId: LayoutId): void {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error(t("error.sceneMissing"));
    const layout = this.presetFor(layoutId);
    scene.layoutId = layout.id;
    scene.slotAssignments = this.sanitizeAssignments(
      layout,
      scene.identityIds,
      scene.slotAssignments,
    );
    scene.updatedAt = new Date().toISOString();
    this.persist();
  }

  setSceneSlotAssignments(sceneId: string, assignments: Record<string, number>): void {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error(t("error.sceneMissing"));
    const layout = this.presetFor(scene.layoutId);
    scene.slotAssignments = this.sanitizeAssignments(layout, scene.identityIds, assignments);
    scene.updatedAt = new Date().toISOString();
    this.persist();
  }

  /**
   * Moves the windows a scene already has open to match its slot assignments.
   * Dragging a member to another slot is pointless if the browser window does not
   * follow, so this is called right after an assignment change.
   */
  async retileScene(sceneId: string): Promise<void> {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const preset = this.presetFor(scene.layoutId);
    const area = this.workArea();
    const taken = new Set<number>();
    await Promise.all(
      scene.identityIds.map(async (identityId, index) => {
        const instance = [...this.liveInstances.values()].find(
          (item) => item.identityId === identityId,
        );
        if (!instance || instance.mode !== "cdp" || !instance.targetId) return;
        const identity = this.data.identities.find((item) => item.id === identityId);
        if (!identity) return;
        const slotIndex = this.resolveSlotIndex(
          preset,
          identity,
          scene.slotAssignments,
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
    // Scenes must never dangle on a deleted preset; fall back to the default grid.
    for (const scene of this.data.scenes) {
      if (scene.layoutId !== id) continue;
      scene.layoutId = "2x2";
      scene.slotAssignments = {};
      scene.updatedAt = new Date().toISOString();
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
      environments: this.data.environments.map((item) => ({ ...item })),
      identities: this.data.identities.map((item) => {
        const { lastCheckedAt: _checked, ...rest } = item;
        return { ...rest, status: "unknown" as const };
      }),
      scenes: this.data.scenes.map((item) => ({
        ...item,
        identityIds: [...item.identityIds],
        slotAssignments: { ...item.slotAssignments },
        paths: { ...item.paths },
      })),
      layoutPresets: this.data.layoutPresets.map((item) => ({
        ...item,
        slots: item.slots.map((slot) => ({ ...slot })),
      })),
    };

    if (passphrase) {
      if (this.vault.locked) throw new Error(t("vault.locked"));
      const secrets = {
        environment: {} as Record<string, string>,
        identity: {} as Record<string, string>,
      };
      for (const environment of this.data.environments) {
        const password = this.vault.get({ kind: "environment", id: environment.id });
        if (password) secrets.environment[environment.id] = password;
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
   * environment is missing are skipped rather than attached to the wrong scope.
   */
  importWorkspace(file: WorkspaceExportFile, passphrase?: string): ImportResult {
    let secrets:
      | { environment: Record<string, string>; identity: Record<string, string> }
      | undefined;
    if (file.secrets) {
      if (!passphrase) throw new Error(t("error.importNeedsPassphrase"));
      try {
        const key = deriveKey(passphrase, file.secrets.kdf);
        const parsed = JSON.parse(open(key, file.secrets.payload)) as {
          environment?: Record<string, string>;
          identity?: Record<string, string>;
        };
        secrets = {
          environment: parsed.environment ?? {},
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

    for (const environment of file.environments) {
      const existing = this.data.environments.find((item) => item.id === environment.id);
      if (existing) {
        Object.assign(existing, environment, { updatedAt: new Date().toISOString() });
        updated += 1;
      } else {
        this.data.environments.push({ ...environment });
        added += 1;
      }
    }

    const environmentIds = new Set(this.data.environments.map((item) => item.id));
    let skipped = 0;
    for (const identity of file.identities) {
      if (!environmentIds.has(identity.environmentId)) {
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
    for (const scene of file.scenes) {
      if (!environmentIds.has(scene.environmentId)) {
        skipped += 1;
        continue;
      }
      const members = scene.identityIds.filter((id) => identityIds.has(id));
      if (members.length === 0) {
        skipped += 1;
        continue;
      }
      const slots = Object.fromEntries(
        Object.entries(scene.slotAssignments).filter(([id]) => members.includes(id)),
      );
      const existing = this.data.scenes.find((item) => item.id === scene.id);
      if (existing) {
        Object.assign(existing, scene, {
          identityIds: members,
          slotAssignments: slots,
          updatedAt: new Date().toISOString(),
        });
        updated += 1;
      } else {
        this.data.scenes.push({ ...scene, identityIds: members, slotAssignments: slots });
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

    let importedSecrets = 0;
    if (secrets) {
      for (const [id, password] of Object.entries(secrets.environment)) {
        if (!environmentIds.has(id)) continue;
        this.vault.set({ kind: "environment", id }, password);
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
      environmentId: environment.id,
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
    this.scheduleAutoFill(identity, environment, outcome.instance);
    await this.learnFrameInset(outcome.instance);
    this.placedBounds.set(outcome.instance.id, bounds);
    if (canRetile) await this.tileInstances(preset, [...this.liveInstances.values()]);
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

    const result = await this.launchGroup(
      environment,
      members,
      this.presetFor(scene.layoutId),
      scene.slotAssignments,
      (identity) => scene.paths[identity.id],
    );
    // Remember the scene for "restore on next start". Written only after every
    // window opened, so a half-failed launch never becomes the restore target.
    this.settings.lastSceneId = scene.id;
    this.settingsStore.write(this.settings);
    return result;
  }

  /**
   * Launches a hand-picked set of identities with the default layout.
   *
   * This is the identities page's batch action: the same tiling and the same
   * launch interval as a scene, but the group is a selection rather than a saved
   * scene, and nothing is remembered for restore-on-start. Starting them one by
   * one instead means every new window covers the cards you are still clicking.
   */
  async launchIdentities(identityIds: string[]): Promise<LaunchResult> {
    const wanted = new Set(identityIds.map(String));
    const members = this.data.identities.filter((identity) => wanted.has(identity.id));
    if (members.length === 0) throw new Error(t("error.sceneMembers"));
    const environmentId = members[0]?.environmentId;
    // One layout describes one screen, so a batch spanning two environments would
    // have no sensible tiling; the UI only ever offers the active environment.
    if (members.some((identity) => identity.environmentId !== environmentId)) {
      throw new Error(t("error.batchMixedEnvironments"));
    }
    const environment = this.data.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    return this.launchGroup(
      environment,
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
    environment: Environment,
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
        const slotIndex = this.resolveSlotIndex(
          preset,
          identity,
          assignments,
          takenSlots,
          index,
        );
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
        const engine = this.resolveEngine(identity, environment);
        const startUrl = joinUrl(
          environment.baseUrl,
          pathFor(identity) ?? identity.startPath ?? environment.loginPath ?? "/",
        );
        const outcome = await launchBrowser({
          environmentId: environment.id,
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
        this.scheduleAutoFill(identity, environment, outcome.instance);
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
   * Reopens the scene that was launched last, once per process. Callers should
   * have the window on screen already: this only starts browsers.
   */
  async restoreLastScene(): Promise<SceneRestoreOutcome> {
    if (this.restoreAttempted) return { restored: false, reason: "already-attempted" };
    this.restoreAttempted = true;
    if (!this.settings.restoreLastScene) return { restored: false, reason: "disabled" };

    const sceneId = this.settings.lastSceneId;
    if (!sceneId) return { restored: false, reason: "no-scene" };
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    const environment = scene
      ? this.data.environments.find((item) => item.id === scene.environmentId)
      : undefined;
    if (!scene || !environment) {
      // The workspace changed while the app was closed. Drop the dangling id
      // instead of retrying it on every start.
      delete this.settings.lastSceneId;
      this.settingsStore.write(this.settings);
      this.emit();
      return { restored: false, reason: "missing" };
    }

    // Engine scanning runs in the background; launching before it finishes can
    // pick no engine at all on a cold start with an empty cache.
    await this.maintenanceDone;
    try {
      await this.launchScene(sceneId);
      return { restored: true, sceneId, sceneName: scene.name };
    } catch (error) {
      return {
        restored: false,
        sceneId,
        sceneName: scene.name,
        reason: (error as Error).message,
      };
    }
  }

  /**
   * Reopens one member after the user closed its window. Without this the only
   * recovery was relaunching the whole scene, which also restarted windows that
   * were still alive.
   */
  async launchSceneMember(sceneId: string, identityId: string): Promise<LaunchResult> {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error(t("error.sceneMissing"));
    const identity = this.data.identities.find(
      (item) => item.id === identityId && item.environmentId === scene.environmentId,
    );
    if (!identity) throw new Error(t("error.identityMissing"));
    const environment = this.data.environments.find((item) => item.id === scene.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));

    const running = [...this.liveInstances.values()].find(
      (instance) => instance.identityId === identityId,
    );
    if (running) return { instance: running, identities: [identity] };

    const preset = this.presetFor(scene.layoutId);
    const taken = new Set<number>();
    for (const memberId of scene.identityIds) {
      if (memberId === identityId) continue;
      const instance = [...this.liveInstances.values()].find(
        (item) => item.identityId === memberId,
      );
      const assigned = scene.slotAssignments[memberId];
      if (instance && typeof assigned === "number") taken.add(assigned);
    }
    const fallback = Math.max(0, scene.identityIds.indexOf(identityId));
    const slotIndex = this.resolveSlotIndex(
      preset,
      identity,
      scene.slotAssignments,
      taken,
      fallback,
    );

    const engine = this.resolveEngine(identity, environment);
    const startUrl = joinUrl(
      environment.baseUrl,
      scene.paths[identity.id] ?? identity.startPath ?? environment.loginPath ?? "/",
    );
    const bounds = this.slotBounds(preset, this.workArea(), slotIndex);
    const outcome = await launchBrowser({
      environmentId: environment.id,
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
    this.scheduleAutoFill(identity, environment, outcome.instance);
    return { instance: outcome.instance, identities: [identity] };
  }

  /**
   * Opens a disposable browser window. With an environment it starts on that
   * login page; without one it opens a blank tab, for the cases where all the
   * user wants is a throwaway browser that belongs to no environment at all.
   */
  async launchCleanSession(environmentId?: string): Promise<LaunchResult> {
    // Reuse of a directory the startup sweep is about to delete must not happen.
    await this.maintenanceDone;
    const environment = environmentId
      ? this.data.environments.find((item) => item.id === environmentId)
      : undefined;
    if (environmentId && !environment) throw new Error(t("error.environmentMissing"));
    const engine =
      this.engines.find((item) => item.id === environment?.defaultEngineId) ??
      this.engines.find((item) => item.cdp);
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
      // Environment-free sessions live in their own segment so deleting an
      // environment can never adopt or stop them.
      environmentId: environment?.id ?? CLEAN_SESSION_SEGMENT,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: `${CLEAN_PROFILE_PREFIX}${instanceId}`,
      startUrl: environment
        ? joinUrl(environment.baseUrl, environment.loginPath || "/")
        : "about:blank",
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
   * Closes only the windows one scene opened.
   *
   * Membership is the scene's current identity list, not the instance's layout:
   * a window launched by hand for an identity that is also in the scene is still
   * that identity's window, and the user asked for "this scene's pages" to go
   * away. Instances started as part of another scene are left alone.
   */
  async stopScene(sceneId: string): Promise<void> {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error(t("error.sceneMissing"));
    const members = new Set(scene.identityIds);
    // Clean sessions and blank windows carry no identity, so they can never be
    // part of a scene; a missing id simply matches nothing.
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
   * `slotByInstance` carries the slots resolved for a scene: without it the index
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

  private requireEnvironment(identity: Identity): Environment {
    const environment = this.data.environments.find((item) => item.id === identity.environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    return environment;
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
   * once at the end instead of once per identity, which matters for a scene of
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

    const environment = this.data.environments.find((item) => item.id === identity.environmentId);
    if (!environment) return unknown(t("error.environmentMissing"));
    const checkPath = environment.authCheckPath;
    if (!checkPath) return unknown(t("auth.noCheckPath"));

    const instance = this.findInstance(identity.id);
    if (instance) {
      const entry = cdpRegistry.get(instance.id);
      if (!entry) return unknown(t("auth.noCdp"));
      return this.checkInOpenWindow(identity, environment, checkPath, entry.page, checkedAt, unknown);
    }

    // No window: run the same check in a temporary headless session over this
    // identity's own profile. This is the case the feature exists for — the user
    // should not have to open eight windows to learn that two of them expired.
    if (this.options.headlessAuthCheck === false) return unknown(t("auth.notRunning"));
    return this.checkHeadless(identity, environment, checkPath, checkedAt, unknown);
  }

  /** Reads the verdict from a page that is already open in a visible window. */
  private async checkInOpenWindow(
    identity: Identity,
    environment: Environment,
    checkPath: string,
    page: Parameters<typeof evaluate>[0],
    checkedAt: string,
    unknown: (detail: string) => { result: AuthCheckResult; changed: boolean },
  ): Promise<{ result: AuthCheckResult; changed: boolean }> {
    try {
      const location = await evaluate<string>(page, "location.href");
      if (!sameOrigin(location, environment.baseUrl)) return unknown(t("auth.crossOrigin"));
      const result = await evaluate<{ status: number; ok: boolean; url: string }>(
        page,
        buildAuthCheckExpression(checkPath),
        { awaitPromise: true },
      );
      return this.recordStatus(identity, checkedAt, result.status);
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
    environment: Environment,
    checkPath: string,
    checkedAt: string,
    unknown: (detail: string) => { result: AuthCheckResult; changed: boolean },
  ): Promise<{ result: AuthCheckResult; changed: boolean }> {
    let engine: Engine;
    try {
      engine = this.resolveEngine(identity, environment);
    } catch (error) {
      return unknown((error as Error).message);
    }
    if (!supportsHeadlessSession(engine)) return unknown(t("auth.noHeadless", { brand: engine.brand }));

    const base = environment.baseUrl.replace(/\/+$/, "");
    const startUrl = `${base}${checkPath}`;
    let session: HeadlessSession | undefined;
    try {
      session = await openHeadlessSession({
        engine,
        profileRoot: this.options.profileRoot,
        environmentId: environment.id,
        profileKey: identity.id,
        userAgent: this.settings.headlessCheckUa,
      });
      // The check runs on the site's own origin, so `credentials: include` sees
      // the profile's real cookies. Navigating first also makes a cross-origin
      // redirect visible instead of silently checking the wrong site.
      await navigateAndWait(session.page, startUrl, 15_000);
      const location = await evaluate<string>(session.page, "location.href");
      if (!sameOrigin(location, environment.baseUrl)) return unknown(t("auth.crossOrigin"));
      const result = await evaluate<{ status: number; ok: boolean; url: string }>(
        session.page,
        buildAuthCheckExpression(checkPath),
        { awaitPromise: true },
      );
      return this.recordStatus(identity, checkedAt, result.status);
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
  ): { result: AuthCheckResult; changed: boolean } {
    const signedIn = httpStatus >= 200 && httpStatus < 300;
    const status = signedIn ? "signed-in" : "expired";
    identity.status = status;
    identity.lastCheckedAt = checkedAt;
    identity.updatedAt = checkedAt;
    return {
      result: { identityId: identity.id, status, checkedAt, detail: `HTTP ${httpStatus}` },
      changed: true,
    };
  }

  /**
   * Runs the login check for one environment (or every identity when omitted).
   * Three at a time: each identity owns a separate browser and CDP socket, so the
   * only shared resource is the page's own server.
   */
  async checkAllAuth(environmentId?: string): Promise<AuthBatchResult> {
    const identities = this.data.identities.filter(
      (identity) => !environmentId || identity.environmentId === environmentId,
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
      ...(environmentId ? { environmentId } : {}),
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
  async reloginExpired(environmentId?: string): Promise<ReloginBatchResult> {
    const targets = this.data.identities.filter(
      (identity) =>
        (!environmentId || identity.environmentId === environmentId) &&
        identity.status === "expired",
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
    let failed = false;
    while (Date.now() < deadline) {
      try {
        last = await this.tryFill(identity, environment, entry.page);
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
