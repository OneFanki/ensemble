import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AppSettings,
  AuthCheckResult,
  CredentialPresence,
  Engine,
  Environment,
  EnvironmentDraft,
  Identity,
  IdentityDraft,
  LaunchResult,
  LayoutKey,
  PasswordOwner,
  Platform,
  RunningInstance,
  Scene,
  SceneDraft,
  SettingsPatch,
  WorkspaceSnapshot,
} from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import { joinUrl, sameOrigin } from "./util/url";
import { mergeManualEngines, scanEngines } from "./engines";
import { t } from "./i18n/translate";
import { CredentialVault, type SecretBox, resolvePassword } from "./credentials/vault";
import { computeGrid, type Rect } from "./layout/grid";
import {
  cdpRegistry,
  launchBrowser,
  stopInstances,
} from "./launch/browser";
import {
  emptyWorkspace,
  findOwnedBrowserProcesses,
  sanitizeWorkspace,
  type WorkspaceData,
} from "./processes/registry";
import { JsonStore } from "./storage/json-store";
import { evaluate, navigateAndWait } from "./cdp/browser";
import { buildAuthCheckExpression, buildFillExpression } from "./cdp/login";

export interface WorkspaceServiceOptions {
  userDataDir: string;
  profileRoot: string;
  platform: Platform;
  secretBox: SecretBox;
  appVersion: string;
  /** Returns the current window work area, injected by Electron so core stays UI free. */
  workArea?: () => Rect;
  onChange?: () => void;
}

export class WorkspaceService {
  private readonly store: JsonStore<WorkspaceData>;
  private readonly settingsStore: JsonStore<AppSettings>;
  private readonly vault: CredentialVault;
  private data: WorkspaceData;
  private settings: AppSettings;
  private engines: Engine[] = [];
  private readonly liveInstances = new Map<string, RunningInstance>();

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.store = new JsonStore(join(options.userDataDir, "workspace.json"), emptyWorkspace);
    this.settingsStore = new JsonStore(
      join(options.userDataDir, "settings.json"),
      () => ({ ...DEFAULT_SETTINGS }),
    );
    this.data = sanitizeWorkspace(this.store.read());
    this.settings = { ...DEFAULT_SETTINGS, ...this.settingsStore.read() };

    const vaultStore = new JsonStore(join(options.userDataDir, "vault.json"), () => ({
      version: 1 as const,
      environment: {},
      identity: {},
    }));
    this.vault = new CredentialVault(options.secretBox, (state) => vaultStore.write(state), vaultStore.read());
  }

  async initialize(): Promise<void> {
    // Anything recorded as running from a previous session is stale: the app owns
    // browser lifetimes, so no instance can survive a restart.
    this.data.instances = [];
    this.persist();
    await this.reapOrphans();
    await this.scanAvailableEngines();
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
    return {
      secure: this.vault.secure,
      backend: this.vault.backend,
      ...(this.vault.secure
        ? {}
        : {
            warning:
              this.vault.backend === "basic_text"
                ? t("vault.basicText")
                : t("vault.unavailable"),
          }),
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
    this.vault.set(owner, password);
    this.persist();
  }

  clearPassword(owner: PasswordOwner): void {
    this.vault.clear(owner);
    this.persist();
  }

  copyPassword(owner: PasswordOwner): string | undefined {
    return this.vault.get(owner);
  }

  // ---------- launching ----------

  private resolveEngine(identity: Identity, environment: Environment): Engine {
    const engineId = identity.engineId ?? environment.defaultEngineId;
    const engine = this.engines.find((item) => item.id === engineId) ?? this.engines.find((item) => item.cdp);
    if (!engine) throw new Error(t("error.noEngine"));
    if (engine.status === "blocked") throw new Error(engine.blockReason ?? t("error.engineBlocked"));
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
    const slots = computeGrid(this.settings.layout, area);
    const slot = slots[this.liveInstances.size % slots.length];

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
    this.persist();
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
        launched.push(outcome.instance);
        startedHere.push(outcome.instance);
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
    return { instance: launched[0] as RunningInstance, identities: members };
  }

  async launchCleanSession(environmentId: string): Promise<LaunchResult> {
    const environment = this.data.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error(t("error.environmentMissing"));
    const engine =
      this.engines.find((item) => item.id === environment.defaultEngineId) ??
      this.engines.find((item) => item.cdp);
    if (!engine) throw new Error(t("error.noEngine"));

    const area = this.workArea();
    const slots = computeGrid(this.settings.layout, area);
    const slot = slots[this.liveInstances.size % slots.length];
    const instanceId = randomUUID();

    const outcome = await launchBrowser({
      environmentId: environment.id,
      profileRoot: this.options.profileRoot,
      engine,
      profileKey: `clean-${instanceId}`,
      startUrl: joinUrl(environment.baseUrl, environment.loginPath || "/"),
      windowBounds: slot,
      label: t("instance.cleanLabel"),
      instanceId,
      clean: true,
    });

    this.liveInstances.set(outcome.instance.id, outcome.instance);
    this.persist();
    return { instance: outcome.instance, identities: [] };
  }

  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.liveInstances.get(instanceId);
    if (!instance) return;
    await stopInstances([instance]);
    this.liveInstances.delete(instanceId);
    this.persist();
  }

  async stopAll(): Promise<void> {
    const instances = [...this.liveInstances.values()];
    await stopInstances(instances);
    this.liveInstances.clear();
    this.persist();
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
    return [...this.liveInstances.values()].find(
      (instance) => instance.identityId === identityId,
    );
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

    const outcome = await evaluate<{
      ok: boolean;
      reason?: string;
      filledUsername: boolean;
      submitted: boolean;
    }>(
      entry.page,
      buildFillExpression({
        username: identity.username,
        password: resolved.password,
        submit: environment.autoSubmit,
      }),
    );

    if (!outcome.ok) {
      throw new Error(t("error.fillFailed", { reason: outcome.reason ?? "unknown" }));
    }

    return {
      identityId,
      status: "unknown",
      checkedAt: new Date().toISOString(),
      detail: outcome.submitted ? t("auth.filledSubmitted") : t("auth.filled"),
    };
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
