import type { Session } from "electron";
import type { DownloadEntry, DownloadState } from "@shared/types";

/**
 * The slice of Electron's `DownloadItem` this module needs.
 *
 * Structural on purpose: the manager can then be driven by fake items in tests
 * without an Electron runtime, while `index.ts` hands it the real ones.
 */
export interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getSavePath(): string;
  getState(): string;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  getStartTime(): number;
  cancel(): void;
  on(event: "updated", listener: () => void): void;
  on(event: "done", listener: (event: unknown, state: string) => void): void;
}

/** The one session event the manager subscribes to. */
export interface DownloadSessionLike {
  on(event: "will-download", listener: (event: unknown, item: DownloadItemLike) => void): void;
}

/** Progress arrives per chunk; the toolbar does not need every one of them. */
const EMIT_INTERVAL_MS = 150;

/**
 * Downloads across every identity partition.
 *
 * Each identity and each clean session has its own session, and Chromium keeps
 * download state per session — so the hook has to be installed on every one of
 * them. `attach` is idempotent per session because partitions are configured
 * again for each tab opened into them.
 *
 * The manager owns the bookkeeping only: opening a finished file and revealing
 * it in Finder are `shell` calls, which live with the IPC handlers so this
 * module stays testable.
 */
export class DownloadManager {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly items = new Map<string, DownloadItemLike>();
  private readonly attached = new WeakSet<object>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: (entries: DownloadEntry[]) => void) {}

  /** Hooks one session; repeated calls for the same session are ignored. */
  attach(ses: Session | DownloadSessionLike): void {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    ses.on("will-download", (_event, item) => this.track(item));
  }

  /** Newest first — the entry the user just triggered sits at the top. */
  list(): DownloadEntry[] {
    return [...this.entries.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  find(id: string): DownloadEntry | undefined {
    return this.entries.get(id);
  }

  cancel(id: string): void {
    this.items.get(id)?.cancel();
  }

  /** Drops a finished entry from the list; a running download is left alone. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state === "progressing") return;
    this.entries.delete(id);
    this.items.delete(id);
    this.emit();
  }

  clear(): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.state === "progressing") continue;
      this.entries.delete(id);
      this.items.delete(id);
    }
    this.emit();
  }

  private track(item: DownloadItemLike): void {
    const id = `dl-${(++this.seq).toString(36)}-${Date.now().toString(36)}`;
    this.items.set(id, item);
    this.entries.set(id, {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      savePath: item.getSavePath(),
      state: normalizeState(item.getState()),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      // Electron reports seconds; the renderer formats milliseconds.
      startedAt: Math.round(item.getStartTime() * 1000) || Date.now(),
    });
    item.on("updated", () => {
      this.refresh(id, item);
      this.emitSoon();
    });
    item.on("done", (_event, state) => {
      // A finished download is the one update the user must not miss, so it
      // skips the throttle and goes out immediately.
      this.refresh(id, item, normalizeState(state));
      this.emit();
    });
    this.emit();
  }

  private refresh(id: string, item: DownloadItemLike, state?: DownloadState): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const next = state ?? normalizeState(item.getState());
    entry.state = next;
    entry.filename = item.getFilename() || entry.filename;
    entry.savePath = item.getSavePath() || entry.savePath;
    entry.receivedBytes = item.getReceivedBytes();
    entry.totalBytes = item.getTotalBytes();
    if (next !== "progressing" && !entry.finishedAt) entry.finishedAt = Date.now();
  }

  private emit(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onChange(this.list());
  }

  private emitSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange(this.list());
    }, EMIT_INTERVAL_MS);
  }
}

function normalizeState(state: string): DownloadState {
  return state === "completed" || state === "cancelled" || state === "interrupted"
    ? state
    : "progressing";
}
