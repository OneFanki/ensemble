import { contextBridge, ipcRenderer } from "electron";

/**
 * 拆出窗口的 preload。
 *
 * 弹窗只是页面容器：这里的桥只有 guest 生命周期通道（挂载、卸载、布局上报），
 * 不带任何文件、凭据或站点能力。安全三件套（sandbox / contextIsolation /
 * 非 nodeIntegration）由创建窗口的一方保证。
 *
 * 通道名在这里内联而不是 import `@shared/ipc`：弹窗开 `sandbox: true`，sandbox
 * 的 preload 不允许 require 任意文件——打包出的相对 chunk 会在运行时静默失败，
 * 整个桥就不会出现。字符串与 `src/shared/ipc.ts` 保持一致；改通道名时两处同改。
 */
const CHANNEL = {
  embeddedGuestRegister: "embedded:guest-register",
  embeddedGuestMount: "embedded:guest-mount",
  embeddedGuestUnmount: "embedded:guest-unmount",
  embeddedGuestLaidOut: "embedded:guest-laid-out",
} as const;

contextBridge.exposeInMainWorld("ensemblePopout", {
  registerEmbeddedGuest: (guestId: number, tabId: string, partition?: string) =>
    ipcRenderer.invoke(CHANNEL.embeddedGuestRegister, guestId, tabId, partition),
  onEmbeddedGuestMount: (
    listener: (payload: {
      tabId: string;
      partition: string;
      url: string;
      allowPopups: boolean;
    }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]): void =>
      listener(payload);
    ipcRenderer.on(CHANNEL.embeddedGuestMount, handler);
    return () => ipcRenderer.removeListener(CHANNEL.embeddedGuestMount, handler);
  },
  onEmbeddedGuestUnmount: (listener: (payload: { tabId: string }) => void): (() => void) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]): void =>
      listener(payload);
    ipcRenderer.on(CHANNEL.embeddedGuestUnmount, handler);
    return () => ipcRenderer.removeListener(CHANNEL.embeddedGuestUnmount, handler);
  },
  confirmEmbeddedGuestLaidOut: (tabId: string) =>
    ipcRenderer.invoke(CHANNEL.embeddedGuestLaidOut, tabId),
});
