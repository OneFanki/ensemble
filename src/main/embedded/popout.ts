import { BrowserWindow, type WebContents } from "electron";

/**
 * 主窗口之外的页面承载窗口（拆窗）。
 *
 * 一个运行中的页面可以拆到独立 OS 窗口，配合系统分屏与多显示器做并排观察。
 * 页面本体仍是 `<webview>` guest（ADR 0011 的载体不变），只是它的宿主窗口从
 * 管理台换成了这里：挂载请求按 tabId 路由到弹窗渲染层，会话分区与 CDP 会话
 * 全程不变（分区在 session 层，与承载窗口无关）。
 *
 * 职责只有窗口簿记；「卸下旧节点 → 在新窗口重建节点」的换代序列在
 * {@link EmbeddedBrowser.remountCarrier}（browser.ts），窗口创建所需的环境知识
 * （路径、图标、主题）由 options 注入。
 *
 * 实测依据（2026-11-18，Electron 45.2.1，spike）：
 * - `<webview>` 节点无法跨窗口迁移：节点从宿主 DOM 移除即销毁 guest，
 *   「重建挂载（同 persist: 分区）」是唯一路径；分区数据与 CDP evaluate 在新
 *   节点上原样可用。
 * - 弹窗最小化时 `capturePage()` 仍出图，guest 的 `Page.captureScreenshot`
 *   不回复（无帧不答）——与主窗口已知的截图路径选择一致。
 * - **弹窗不挂 `parent`。** 挂上之后它是主窗口的 owned window：主窗口最小化时
 *   弹窗跟着不可见（实测同一 spike 里 child.isVisible() 由 true 变 false），
 *   而拆窗要的正是「主窗口收起来，这一页还在」。不留孤儿的意图由
 *   {@link PopoutManager.dockAll} 承担：主窗口销毁与退出两条路径各调一次，
 *   回收不依赖窗口之间的父子关系。
 */
export interface PopoutManagerOptions {
  /**
   * 创建弹窗窗口。
   *
   * 实现方负责安全三件套（`sandbox` / `contextIsolation` / 非 `nodeIntegration`）、
   * `webviewTag: true`、专用 preload 与开发态加载地址。**不要**挂 `parent`：
   * 生命周期由本类的登记表管理；窗口之间的父子关系会让主窗口的最小化连带
   * 弹窗不可见。
   */
  createWindow(tabId: string): Promise<BrowserWindow>;
  /**
   * 弹窗被用户关闭（点 X / 系统关窗）后回调。
   *
   * 弹窗此刻已经销毁，页面要回到主舞台：编排层在这里做换代挂载。
   */
  onWindowClosed(tabId: string): void;
}

interface PopoutRecord {
  win: BrowserWindow;
}

/** 同一实例同时只允许一个弹窗；错误信息给 MCP 调用方看。 */
export class InstancePopoutExistsError extends Error {
  constructor() {
    super("该浏览器实例已有一个拆出窗口");
    this.name = "InstancePopoutExistsError";
  }
}

export class PopoutManager {
  private readonly entries = new Map<string, PopoutRecord>();
  /** tabId → instanceId，用于「同实例一个弹窗」的检查与标题同步。 */
  private readonly instanceByTab = new Map<string, string>();

  constructor(private readonly options: PopoutManagerOptions) {}

  has(tabId: string): boolean {
    return this.entries.has(tabId);
  }

  /** All popped-out tab ids, for bulk reclaim on quit. */
  tabIds(): string[] {
    return [...this.entries.keys()];
  }

  windowFor(tabId: string): BrowserWindow | undefined {
    return this.entries.get(tabId)?.win;
  }

  hostWebContents(tabId: string): WebContents | undefined {
    const win = this.windowFor(tabId);
    if (!win || win.isDestroyed()) return undefined;
    return win.webContents;
  }

  /** 弹窗内容区尺寸（CSS 像素）；窗口已关时返回 undefined。 */
  contentSize(tabId: string): { width: number; height: number } | undefined {
    const win = this.windowFor(tabId);
    if (!win || win.isDestroyed()) return undefined;
    const [width, height] = win.getContentSize();
    return { width: width ?? 0, height: height ?? 0 };
  }

  visibility(tabId: string): { visible: boolean; minimized: boolean } | undefined {
    const win = this.windowFor(tabId);
    if (!win || win.isDestroyed()) return undefined;
    return { visible: win.isVisible(), minimized: win.isMinimized() };
  }

  /** 拆出窗口总数（诊断与状态广播用）。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 拆出一个页面：创建窗口、登记映射、挂关闭钩子。
   *
   * 「同实例同时只允许一个弹窗」在这里裁决，防止同一实例的两页各占一个窗口
   * 后互相争抢会话（同一分区的两个窗口没有隔离意义，只会泄漏窗口）。
   * 节点换代由调用方在登记之后做——挂载请求按 tabId 路由，先登记再换代，
   * 新节点才会落在弹窗里。
   */
  async popOut(tabId: string, instanceId: string): Promise<BrowserWindow> {
    for (const [poppedTab, instance] of this.instanceByTab) {
      if (instance === instanceId && poppedTab !== tabId && this.entries.has(poppedTab)) {
        throw new InstancePopoutExistsError();
      }
    }
    const existing = this.entries.get(tabId);
    if (existing) return existing.win;
    const win = await this.options.createWindow(tabId);
    this.entries.set(tabId, { win });
    this.instanceByTab.set(tabId, instanceId);
    win.once("closed", () => {
      // 只在仍登记时清理：收回（dock）路径先撤销登记再关窗，不经过这里。
      if (this.entries.get(tabId)?.win !== win) return;
      this.entries.delete(tabId);
      this.instanceByTab.delete(tabId);
      this.options.onWindowClosed(tabId);
    });
    return win;
  }

  /**
   * 收回：撤销登记并销毁窗口。
   *
   * `once("closed")` 钩子按登记判断，撤销登记后关窗不会触发回主舞台的换代。
   */
  async dock(tabId: string): Promise<void> {
    const record = this.entries.get(tabId);
    this.entries.delete(tabId);
    this.instanceByTab.delete(tabId);
    const win = record?.win;
    if (!win || win.isDestroyed()) return;
    await new Promise<void>((resolve) => {
      win.once("closed", () => resolve());
      win.destroy();
    });
  }

  /** 退出与主窗口关闭时的整体回收；不等换代，直接销毁。 */
  async dockAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((tabId) => this.dock(tabId)));
  }

  /** 弹窗标题跟随页面标题（strip 上已有同一份标题，弹窗只是把它放进系统标题栏）。 */
  setTitle(tabId: string, title: string): void {
    const win = this.windowFor(tabId);
    if (!win || win.isDestroyed() || !title) return;
    win.setTitle(title);
  }
}
