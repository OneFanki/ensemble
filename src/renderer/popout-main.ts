/**
 * 拆出窗口的渲染层。
 *
 * 与主窗口的 GuestPool 同一契约的最小子集：主进程发来挂载请求，这里创建
 * `<webview>` 节点（分区与 URL 是创建期属性），`dom-ready` 后上报 guest id，
 * 节点占满窗口内容区并随 resize 跟随。不走 Vue 应用——弹窗没有任何宿主 UI，
 * 独立入口也把这片代码与浏览器页 UI 的改动面隔开。
 *
 * 节点唯一：一个弹窗承载一个页面；收到新挂载请求时旧节点已由主进程卸载。
 */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

interface PopoutBridge {
  registerEmbeddedGuest(guestId: number, tabId: string, partition?: string): Promise<void>;
  onEmbeddedGuestMount(
    listener: (payload: { tabId: string; partition: string; url: string; allowPopups: boolean }) => void,
  ): () => void;
  onEmbeddedGuestUnmount(listener: (payload: { tabId: string }) => void): () => void;
  confirmEmbeddedGuestLaidOut(tabId: string): Promise<void>;
}

const bridge = (window as unknown as { ensemblePopout: PopoutBridge }).ensemblePopout;

/*
 * 底色跟随主进程的主题。
 *
 * 弹窗入口刻意不走 Vue 应用，也就没有 workspace store 可读；主题由创建窗口的
 * 主进程作为 query 参数带进来（`popout.html?theme=dark`），这里只把结论写到
 * `<html>` 上，颜色本身留在 CSS 里。它只覆盖页面加载出第一帧之前的那一层底色。
 */
const requestedTheme = new URLSearchParams(window.location.search).get("theme");
document.documentElement.dataset["theme"] = requestedTheme === "light" ? "light" : "dark";

let node: WebviewElement | null = null;
/** 尺寸定过一次就上报，换代后新节点重新上报。 */
let laidOutReported = false;

function mount(payload: {
  tabId: string;
  partition: string;
  url: string;
  allowPopups: boolean;
}): void {
  node?.remove();
  laidOutReported = false;
  const element = document.createElement("webview") as unknown as WebviewElement;
  // 与主窗口 GuestPool 相同的诊断通道：DevTools 里能看出节点属于哪个页面。
  element.dataset["tabId"] = payload.tabId;
  element.setAttribute("partition", payload.partition);
  // 创建期能力：没有它，`target="_blank"` 与 OAuth 弹窗的请求在到达主进程前
  // 就被 Chromium 拒掉。
  if (payload.allowPopups) element.setAttribute("allowpopups", "");
  element.setAttribute("src", payload.url);
  element.addEventListener("dom-ready", () => {
    let guestId = 0;
    try {
      guestId = element.getWebContentsId();
    } catch {
      // 节点在事件与读取之间被拆掉时没有 guest。
    }
    if (!guestId) return;
    void bridge.registerEmbeddedGuest(guestId, payload.tabId, payload.partition);
  });
  node = element;
  document.body.appendChild(element);
  // 下一帧再上报布局：节点刚插入时还没有真实的盒子。
  requestAnimationFrame(() => {
    if (!node || laidOutReported) return;
    laidOutReported = true;
    void bridge.confirmEmbeddedGuestLaidOut(payload.tabId).catch(() => undefined);
  });
}

bridge.onEmbeddedGuestMount(mount);
bridge.onEmbeddedGuestUnmount(() => {
  // 主进程此时已经关闭该页的 CDP 会话；收到指令后移除节点才是安全的。
  if (node) node.remove();
  node = null;
  laidOutReported = false;
});
