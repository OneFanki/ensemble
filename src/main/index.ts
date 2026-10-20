import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  nativeImage,
  safeStorage,
  screen,
  shell,
} from "electron";
import { IPC, type ExportOutcome, type ImportPickOutcome } from "@shared/ipc";
import type {
  AppSettings,
  EnvironmentDraft,
  IdentityDraft,
  LayoutId,
  LayoutPresetDraft,
  McpPatch,
  PasswordOwner,
  SceneDraft,
  SettingsPatch,
} from "@shared/types";
import {
  environmentDraftSchema,
  identityDraftSchema,
  layoutPresetDraftSchema,
  passwordOwnerSchema,
  sceneDraftSchema,
  settingsPatchSchema,
} from "@shared/schemas";
import { parseExportFile } from "@shared/transfer";
import {
  LATEST_RELEASE_API,
  evaluateUpdate,
  parseLatestRelease,
  type UpdateCheckResult,
} from "@shared/update";
import { WorkspaceService } from "@core/service";
import { setCoreLocale } from "@core/i18n/translate";
import type { SecretBox } from "@core/credentials/vault";
import { McpServer } from "./mcp/server";

const isDev = Boolean(process.env["ELECTRON_RENDERER_URL"]);

class SafeStorageBox implements SecretBox {
  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  get backend(): string {
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend?.();
      return backend ?? "unknown";
    }
    return process.platform === "win32"
      ? "dpapi"
      : process.platform === "darwin"
        ? "keychain"
        : "unknown";
  }

  get kind(): "os" {
    return "os";
  }

  encrypt(plain: string): string {
    // There is no plaintext fallback: a machine without a usable keychain must
    // either install one or protect the vault with a master password.
    if (!this.available) {
      throw new Error("System credential storage is unavailable");
    }
    return `enc:${safeStorage.encryptString(plain).toString("base64")}`;
  }

  decrypt(payload: string): string {
    if (payload.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(payload.slice(4), "base64"));
    }
    throw new Error("Unknown credential payload");
  }
}

let mainWindow: BrowserWindow | null = null;
let service: WorkspaceService | null = null;
let quitting = false;
let currentTheme: AppSettings["theme"] = "dark";
let tray: Tray | null = null;
let mcpServer: McpServer | null = null;
/** Kept in sync so the close handler does not need the service to be initialized. */
let settingsCache: AppSettings | null = null;
/** A parsed import file waiting for its confirmation, keyed by absolute path. */
let pendingImport: { path: string; payload: ReturnType<typeof parseExportFile> } | null = null;

/** Native window-control colors mirror the renderer tokens for each theme. */
const TITLEBAR_COLORS = {
  dark: { color: "#12151a", symbolColor: "#a3abb8" },
  light: { color: "#faf7f0", symbolColor: "#565049" },
} as const;

function isDarkTheme(theme: AppSettings["theme"]): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

function titleBarOverlay(theme: AppSettings["theme"]): Electron.TitleBarOverlay {
  return { ...TITLEBAR_COLORS[isDarkTheme(theme) ? "dark" : "light"], height: 44 };
}

function userDataDir(): string {
  return app.getPath("userData");
}

function profileRoot(): string {
  return join(userDataDir(), "profiles");
}

function broadcastWorkspace(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !service) return;
  mainWindow.webContents.send(IPC.workspaceChanged, service.snapshot());
}

/**
 * Windows are placed on the display the control panel lives on. Using the cursor
 * picked the wrong monitor whenever the mouse was on another screen, which is
 * how a launch could land somewhere the user was not looking.
 */
function workAreaRect(): { x: number; y: number; width: number; height: number } {
  const bounds = mainWindow?.isDestroyed() ? undefined : mainWindow?.getBounds();
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function buildAssetPath(file: string): string {
  // Packaged: unpacked next to the asar so the native tray loader can read it
  // without going through the archive.
  return app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "build", file)
    : join(__dirname, "../../build", file);
}

function loadTrayImage(): Electron.NativeImage {
  if (process.platform === "darwin") {
    // The menu bar only uses the alpha channel of a template image, so the
    // colored app mark would render as a solid block. 16pt + @2x keeps the
    // glyph sharp and lets macOS tint it for light and dark menu bars.
    const template = nativeImage.createFromPath(buildAssetPath("trayTemplate.png"));
    if (!template.isEmpty()) {
      // nativeImage pairs trayTemplate@2x.png automatically on Retina displays;
      // the Template suffix also marks it as a template image, but set it
      // explicitly so a renamed asset cannot silently lose the tinting.
      template.setTemplateImage(true);
      return template;
    }
  }
  for (const file of ["tray.png", "icon.png"]) {
    const image = nativeImage.createFromPath(buildAssetPath(file));
    if (!image.isEmpty()) return image;
  }
  // A missing tray asset must not break the tray; an empty image keeps the app
  // running invisibly rather than crashing at startup.
  return nativeImage.createFromBuffer(Buffer.from("", "utf8"));
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(loadTrayImage());
  tray.setToolTip("Ensemble");
  const rebuild = () => {
    if (!tray) return;
    const mcp = mcpServer?.status();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Ensemble", click: () => showMainWindow() },
        { type: "separator" },
        {
          label: mcp?.running ? `AI 接入：已开启 (${mcp.port})` : "AI 接入：已关闭",
          enabled: false,
        },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            void shutdownAndQuit();
          },
        },
      ]),
    );
  };
  rebuild();
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  trayRebuild = rebuild;
}

let trayRebuild: (() => void) | null = null;

async function createWindow(): Promise<void> {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    // Show immediately: a dark window frame appears in well under a second and the
    // first paint lands right after. Waiting for ready-to-show makes startup feel
    // several hundred milliseconds slower than it is.
    show: true,
    backgroundColor: isDarkTheme(currentTheme) ? "#0b0d10" : "#f3efe6",
    title: "Ensemble",
    titleBarStyle: "hidden",
    // Packaged builds take the executable icon (build/icon.ico); in development
    // the window and taskbar need it passed explicitly.
    ...(app.isPackaged ? {} : { icon: join(__dirname, "../../build/icon.png") }),
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {
          titleBarOverlay: titleBarOverlay(currentTheme),
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  mainWindow.on("close", (event) => {
    if (quitting) return;
    // Closing the window is the common accident; the tray keeps the MCP endpoint
    // and any running browsers alive. Quit explicitly from the tray or the menu.
    if (settingsCache?.closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    event.preventDefault();
    void shutdownAndQuit();
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Setting the overlay only in the constructor leaves the caption buttons in the
  // default dark palette on some Windows builds; reapplying once the window exists
  // (and on every theme change) is what actually colors them.
  if (!isMac) mainWindow.setTitleBarOverlay(titleBarOverlay(currentTheme));
  createTray();
}

async function shutdownAndQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    // Order matters: stop accepting new AI requests before tearing down browsers,
    // so a tool call cannot start a launch halfway through shutdown.
    await mcpServer?.stop();
    tray?.destroy();
    tray = null;
    await service?.shutdown();
  } finally {
    app.quit();
  }
}

function applyTheme(theme: AppSettings["theme"]): void {
  currentTheme = theme;
  nativeTheme.themeSource = theme;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(isDarkTheme(theme) ? "#0b0d10" : "#f3efe6");
  if (process.platform !== "darwin") {
    mainWindow.setTitleBarOverlay(titleBarOverlay(theme));
  }
}

function registerIpc(workspace: WorkspaceService): void {
  const handle = <T>(channel: string, listener: (...args: any[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (_event, ...args) => listener(...args));
  };

  handle(IPC.workspaceGet, () => workspace.snapshot());

  handle(IPC.enginesScan, async () => {
    const engines = await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return engines;
  });

  handle(IPC.enginesAddManual, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择浏览器可执行文件",
      properties: ["openFile"],
      ...(process.platform === "win32"
        ? { filters: [{ name: "可执行文件", extensions: ["exe"] }] }
        : {}),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return workspace.enginesSnapshot();
    }
    const filePath = result.filePaths[0] as string;
    workspace.addManualEngine(filePath);
    await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return workspace.enginesSnapshot();
  });

  handle(IPC.enginesRemoveManual, async (exePath: string) => {
    workspace.removeManualEngine(String(exePath));
    await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return workspace.enginesSnapshot();
  });

  handle(IPC.environmentSave, (draft: EnvironmentDraft) => {
    workspace.saveEnvironment(environmentDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.environmentDelete, (id: string) => {
    workspace.deleteEnvironment(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.identitySave, (draft: IdentityDraft) => {
    const parsed = identityDraftSchema.parse(draft);
    const { password, ...rest } = parsed;
    workspace.saveIdentity(rest, password);
    broadcastWorkspace();
    return workspace.snapshot();
  });
  handle(IPC.identityDelete, (id: string) => {
    workspace.deleteIdentity(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.identityRebuildProfile, async (id: string) => {
    await workspace.rebuildIdentityProfile(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.sceneSave, (draft: SceneDraft) => {
    workspace.saveScene(sceneDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.sceneDelete, (id: string) => {
    workspace.deleteScene(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.sceneSetLayout, (sceneId: string, layoutId: LayoutId) => {
    workspace.setSceneLayout(String(sceneId), String(layoutId));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.sceneSetSlots, (sceneId: string, assignments: Record<string, number>) => {
    workspace.setSceneSlotAssignments(String(sceneId), assignments);
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.sceneRetile, async (sceneId: string) => {
    await workspace.retileScene(String(sceneId));
  });

  handle(IPC.layoutPresetSave, (draft: LayoutPresetDraft) => {
    const preset = workspace.saveLayoutPreset(layoutPresetDraftSchema.parse(draft));
    broadcastWorkspace();
    return preset;
  });

  handle(IPC.layoutPresetDelete, (id: LayoutId) => {
    workspace.deleteLayoutPreset(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsSet, (owner: PasswordOwner, password: string) => {
    workspace.setPassword(passwordOwnerSchema.parse(owner), String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsClear, (owner: PasswordOwner) => {
    workspace.clearPassword(passwordOwnerSchema.parse(owner));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsCopy, (owner: PasswordOwner) => {
    const password = workspace.copyPassword(passwordOwnerSchema.parse(owner));
    if (!password) return false;
    clipboard.writeText(password);
    setTimeout(() => {
      void clipboard.readText().then((current) => {
        if (current === password) clipboard.clear();
      });
    }, 30_000);
    return true;
  });

  handle(IPC.credentialsUnlock, (password: string) => workspace.unlockVault(String(password)));

  handle(IPC.credentialsLock, () => {
    workspace.lockVault();
    return workspace.snapshot();
  });

  handle(IPC.credentialsSetMaster, (password: string) => {
    workspace.setMasterPassword(String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsRemoveMaster, () => {
    workspace.removeMasterPassword();
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsChangeMaster, (current: string, next: string) => {
    const changed = workspace.changeMasterPassword(String(current), String(next));
    if (changed) broadcastWorkspace();
    return changed;
  });

  handle(IPC.instanceLaunch, async (identityId: string, pathOverride?: string) => {
    const result = await workspace.launchIdentity(String(identityId), pathOverride);
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceLaunchScene, async (sceneId: string) => {
    const result = await workspace.launchScene(String(sceneId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceLaunchSceneMember, async (sceneId: string, identityId: string) => {
    const result = await workspace.launchSceneMember(String(sceneId), String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceClean, async (environmentId?: string) => {
    const result = await workspace.launchCleanSession(
      environmentId ? String(environmentId) : undefined,
    );
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceStop, async (id: string) => {
    await workspace.stopInstance(String(id));
    broadcastWorkspace();
  });

  handle(IPC.instanceStopAll, async () => {
    await workspace.stopAll();
    broadcastWorkspace();
  });

  handle(IPC.authCheck, async (identityId: string) => {
    const result = await workspace.checkAuth(String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.authFill, async (identityId: string) => {
    const result = await workspace.fillLogin(String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.settingsSave, (patch: SettingsPatch) => {
    const parsed = settingsPatchSchema.parse(patch);
    const settings = workspace.saveSettings(parsed);
    settingsCache = settings;
    if (parsed.theme) applyTheme(parsed.theme);
    if (parsed.locale) setCoreLocale(parsed.locale);
    broadcastWorkspace();
    return settings;
  });

  handle(IPC.dataExport, async (options: { includeSecrets: boolean; passphrase?: string }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "导出配置",
      defaultPath: join(app.getPath("documents"), `ensemble-${dateStamp()}.json`),
      filters: [{ name: "Ensemble 配置", extensions: ["json"] }],
    });
    const outcome: ExportOutcome = { canceled: true };
    if (canceled || !filePath) return outcome;
    const passphrase = String(options?.passphrase ?? "");
    const exported = workspace.exportWorkspace(options?.includeSecrets ? passphrase : undefined);
    writeFileSync(filePath, `${JSON.stringify(exported.file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      canceled: false,
      path: filePath,
      counts: exported.counts,
      secretsIncluded: exported.secretsIncluded,
    } satisfies ExportOutcome;
  });

  handle(IPC.dataImportPick, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "导入配置",
      properties: ["openFile"],
      filters: [{ name: "Ensemble 配置", extensions: ["json"] }],
    });
    const outcome: ImportPickOutcome = { canceled: true };
    const filePath = filePaths?.[0];
    if (canceled || !filePath) return outcome;
    let payload: ReturnType<typeof parseExportFile>;
    try {
      payload = parseExportFile(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (error) {
      throw new Error(`无法读取该文件：${(error as Error).message}`);
    }
    pendingImport = { path: filePath, payload };
    return {
      canceled: false,
      path: filePath,
      preview: {
        version: payload.version,
        exportedAt: payload.exportedAt,
        hasSecrets: Boolean(payload.secrets),
        environments: payload.environments.length,
        identities: payload.identities.length,
        scenes: payload.scenes.length,
        layoutPresets: payload.layoutPresets.length,
      },
    } satisfies ImportPickOutcome;
  });

  handle(IPC.dataImportApply, (passphrase?: string) => {
    if (!pendingImport) throw new Error("请先选择要导入的配置文件");
    const { payload } = pendingImport;
    // Clear only after the merge succeeds: a wrong passphrase throws before any
    // write, and dropping the payload here would force the user to re-pick the
    // very same file just to retype it.
    const result = workspace.importWorkspace(payload, passphrase ? String(passphrase) : undefined);
    pendingImport = null;
    broadcastWorkspace();
    return result;
  });

  handle(IPC.mcpInfo, () => mcpServer?.status());

  handle(IPC.mcpUpdate, async (patch: McpPatch) => {
    if (!mcpServer) throw new Error("MCP 服务未初始化");
    const status = await mcpServer.update(patch ?? {});
    trayRebuild?.();
    return status;
  });

  handle(IPC.appSetTheme, (theme: AppSettings["theme"]) => {
    applyTheme(theme);
  });

  handle(IPC.appQuit, async () => {
    await shutdownAndQuit();
  });

  handle(IPC.appOpenExternal, async (url: string) => {
    // The renderer only ever passes URLs from its own message table, but a
    // compromised renderer would otherwise get a system-browser launch for any
    // scheme. Restrict to the two the UI needs.
    if (!/^https?:\/\//i.test(String(url))) return;
    await shell.openExternal(String(url));
  });

  handle(IPC.appCheckUpdate, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(LATEST_RELEASE_API, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ensemble-update-check" },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "error",
          current: app.getVersion(),
          message: `HTTP ${response.status}`,
        } satisfies UpdateCheckResult;
      }
      return evaluateUpdate(app.getVersion(), parseLatestRelease(await response.json()));
    } catch (error) {
      return {
        status: "error",
        current: app.getVersion(),
        message: (error as Error).message,
      } satisfies UpdateCheckResult;
    } finally {
      clearTimeout(timer);
    }
  });

  handle(IPC.windowMinimize, () => {
    mainWindow?.minimize();
  });

  handle(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });

  handle(IPC.windowClose, () => {
    mainWindow?.close();
  });

  handle(IPC.windowShow, () => {
    showMainWindow();
  });
}

function dateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

// A second instance would own its own browsers and MCP port, and both would write
// workspace.json. The first instance wins and simply reveals its window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    mkdirSync(profileRoot(), { recursive: true });

    service = new WorkspaceService({
      userDataDir: userDataDir(),
      profileRoot: profileRoot(),
      platform: process.platform as "win32" | "darwin" | "linux",
      secretBox: new SafeStorageBox(),
      appVersion: app.getVersion(),
      workArea: workAreaRect,
      onChange: broadcastWorkspace,
      onAutoFill: (report) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.authAutoFilled, report);
        }
      },
    });

    settingsCache = service.settingsSnapshot();
    setCoreLocale(settingsCache.locale);
    applyTheme(settingsCache.theme);

    // Follow OS appearance changes while the setting is "system": the renderer
    // gets prefers-color-scheme updates itself, but the native window background
    // and Windows/Linux caption buttons have to be recolored here.
    nativeTheme.on("updated", () => {
      if (currentTheme !== "system") return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setBackgroundColor(isDarkTheme("system") ? "#0b0d10" : "#f3efe6");
      if (process.platform !== "darwin") {
        mainWindow.setTitleBarOverlay(titleBarOverlay("system"));
      }
    });

    // initialize() only reads local JSON and the engine cache, so the window can
    // appear right away. Orphan sweeping and engine scanning run afterwards.
    await service.initialize();
    settingsCache = service.settingsSnapshot();

    mcpServer = new McpServer({
      settingsPath: join(userDataDir(), "mcp.json"),
      auditPath: join(userDataDir(), "mcp-audit.log"),
      service,
      appVersion: app.getVersion(),
      onChange: broadcastWorkspace,
    });

    registerIpc(service);
    await createWindow();
    await mcpServer.start();

    void service.startBackgroundMaintenance();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      else showMainWindow();
    });
  });
}

// Registering this listener takes over the quit decision: without an explicit
// app.quit() here the process stays alive after the last window closes (and a
// portable build's exe stays locked on Windows).
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (quitting) {
    app.quit();
    return;
  }
  // Tray mode keeps the process (and with it the MCP endpoint) alive even if the
  // window was destroyed without a close event.
  if (settingsCache?.closeToTray) return;
  // Windows were destroyed without a close event; still stop our browsers.
  void shutdownAndQuit();
});

/**
 * Every quit path (tray menu, system shutdown, `app.quit()` from anywhere) funnels
 * through the same teardown: the MCP socket is closed first so no AI client can
 * start work while browsers are being reclaimed.
 */
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdownAndQuit();
});

process.on("uncaughtException", (error) => {
  console.error("[ensemble] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ensemble] unhandled rejection", reason);
});
