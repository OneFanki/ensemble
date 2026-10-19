interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpErrorShape {
  code: number;
  message: string;
  data?: string;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  private closed = false;

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(typeof event.data === "string" ? event.data : String(event.data));
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (!WebSocketCtor) {
      return Promise.reject(new Error("This runtime does not expose a WebSocket implementation"));
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);

      const onOpen = () => {
        clearTimeout(timer);
        socket.removeEventListener("error", onError);
        resolve(new CdpClient(socket));
      };
      const onError = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        reject(new Error(`Cannot connect to ${url}`));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("CDP connection is closed"));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 20_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, listener: (params: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "CDP call failed") as Error & CdpErrorShape;
        error.code = message.error.code;
        error.data = message.error.data;
        call.reject(error);
      } else {
        call.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      const set = this.listeners.get(message.method);
      if (!set) return;
      for (const listener of set) {
        try {
          listener(message.params);
        } catch {
          // A listener must never break the protocol loop.
        }
      }
    }
  }
}
