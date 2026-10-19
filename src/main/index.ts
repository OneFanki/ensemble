import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
  shell,
} from "electron";
import { IPC } from "@shared/ipc";
import type {
  AppSettings,
  EnvironmentDraft,
  IdentityDraft,
  PasswordOwner,
  SceneDraft,
  SettingsPatch,
} from "@shared/types";
import {
  environmentDraftSchema,
  identityDraftSchema,
  passwordOwnerSchema,
  sceneDraftSchema,
  settingsPatchSchema,
} from "@shared/schemas";
import { WorkspaceService } from "@core/service";
import { setCoreLocale } from "@core/i18n/translate";
import type { SecretBox } from "@core/credentials/vault";

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
    return process.platform === "win32" ? "dpapi" : process.platform === "darwin" ? "keychain" : "unknown";
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
    backgroundColor: "#0b0d10",
    title: "Ensemble",
    titleBarStyle: "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {
          titleBarOverlay: {
            color: "#0d1014",
            symbolColor: "#8d95a3",
            height: 44,
          },
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
    event.preventDefault();
    void shutdownAndQuit();
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function shutdownAndQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    await service?.shutdown();
  } finally {
    app.quit();
  }
}

function applyTheme(theme: AppSettings["theme"]): void {
  nativeTheme.themeSource = theme;
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

  handle(IPC.instanceClean, async (environmentId: string) => {
    const result = await workspace.launchCleanSession(String(environmentId));
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
    if (parsed.theme) applyTheme(parsed.theme);
    if (parsed.locale) setCoreLocale(parsed.locale);
    broadcastWorkspace();
    return settings;
  });

  handle(IPC.appSetTheme, (theme: AppSettings["theme"]) => {
    applyTheme(theme);
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
}

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

  setCoreLocale(service.settingsSnapshot().locale);
  applyTheme(service.settingsSnapshot().theme);

  // initialize() only reads local JSON and the engine cache, so the window can
  // appear right away. Orphan sweeping and engine scanning run afterwards.
  await service.initialize();
  registerIpc(service);
  await createWindow();

  void service.startBackgroundMaintenance();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// Registering this listener takes over the quit decision: without an explicit
// app.quit() here the process stays alive after the last window closes (and a
// portable build's exe stays locked on Windows).
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (quitting) {
    app.quit();
    return;
  }
  // Windows were destroyed without a close event; still stop our browsers.
  void shutdownAndQuit();
});

app.on("before-quit", () => {
  quitting = true;
});

process.on("uncaughtException", (error) => {
  console.error("[ensemble] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ensemble] unhandled rejection", reason);
});
