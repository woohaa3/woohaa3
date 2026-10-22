/**
 * 前后台状态与同源多标签页提醒 owner 协调
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.3 / design D8）。
 *
 * - 前台判定：Web 用 `document.hidden || !document.hasFocus()`；Tauri 由原生焦点事实补充，
 *   避免 WebView DOM 焦点与 OS 状态不一致；
 * - 同源多标签页以「实例 + basePath + 数据范围」为协调键，选举单一提醒 owner，避免同一任务
 *   重复提示；owner 退出后其它标签页可接管，且不重放已提醒结果；
 * - 不同 worktree 挂载（不同 basePath）互不串扰。
 *
 * 纯逻辑 + 可注入 channel/locks，便于确定性回归（jsdom 无 Web Locks 时退化为单标签页 owner）。
 */

export type ForegroundState = {
  isBackground(): boolean;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

/** 默认前后台判定：隐藏或失焦都算后台（应用在前台打开设置仍算正在使用）。 */
export function createForegroundState(options: {
  doc?: Pick<Document, "hidden" | "hasFocus" | "addEventListener" | "removeEventListener"> | null;
  win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
} = {}): ForegroundState {
  const doc = options.doc ?? (globalThis.document as ForegroundStateDocument | undefined) ?? null;
  const win = options.win ?? (globalThis.window as ForegroundStateWindow | undefined) ?? null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onVisibility = () => notify();
  const onFocus = () => notify();
  const onBlur = () => notify();
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("focus", onFocus);
  win?.addEventListener("blur", onBlur);

  return {
    isBackground() {
      if (!doc) return false;
      const hidden = doc.hidden === true;
      const focused = typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
      return hidden || !focused;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("focus", onFocus);
      win?.removeEventListener("blur", onBlur);
    }
  };
}

type ForegroundStateDocument = {
  hidden?: boolean;
  hasFocus?: () => boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

type ForegroundStateWindow = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** 选举结果：`owner` 才能发送提醒；`standby` 只观察不发送。 */
export type ReminderRole = "owner" | "standby";

export type ReminderCoordinator = {
  /** 当前角色（异步选举完成前为 standby）。 */
  role(): ReminderRole;
  subscribe(listener: () => void): () => void;
  /** 尝试成为 owner（幂等）。 */
  claim(): Promise<ReminderRole>;
  /** 主动让出（关闭页面/测试）。 */
  release(): Promise<void>;
  /** 是否已有前台标签页活跃（owner 据此抑制后台提醒）。 */
  setPeerForeground(foreground: boolean): void;
  isPeerForeground(): boolean;
  dispose(): void;
};

export type ReminderLocks = {
  request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
};

export type ReminderBroadcast = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type ReminderMessage =
  | { type: "foreground"; at: number }
  | { type: "background"; at: number }
  | { type: "owner-held" };

/**
 * 单 owner 协调。
 *
 * 优先使用 Web Locks：`ifAvailable` 拿不到锁说明别的标签页已是 owner，本页退为 standby；
 * 没有 Web Locks 或无 BroadcastChannel 时退化为单标签页 owner（不声称跨标签页去重）。
 */
export function createReminderCoordinator(options: {
  /** 协调键（实例 + basePath + 数据范围）。 */
  key: string;
  locks?: ReminderLocks | null;
  createChannel?: (name: string) => ReminderBroadcast | null;
  now?: () => number;
}): ReminderCoordinator {
  const now = options.now ?? Date.now;
  let role: ReminderRole = "standby";
  let peerForeground = false;
  let disposing = false;
  const listeners = new Set<() => void>();
  const channel =
    options.createChannel?.(`woohaa-task-notifications:${options.key}`) ?? null;
  let lockHeld = false;
  /** 持锁期间等待 release/dispose 的 resolver（实例级；与每次 claim 一一对应）。 */
  const releaseWaiters = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };
  const setRole = (next: ReminderRole) => {
    if (role === next) return;
    role = next;
    publish();
  };

  if (channel) {
    channel.onmessage = (event) => {
      const message = event.data as ReminderMessage | null;
      if (!message || typeof message !== "object") return;
      if (message.type === "foreground") {
        peerForeground = true;
        publish();
      } else if (message.type === "background") {
        peerForeground = false;
        publish();
      } else if (message.type === "owner-held") {
        // 已有 owner：本页退为 standby，避免重复发送。
        if (!lockHeld) setRole("standby");
      }
    };
  }

  return {
    role: () => role,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async claim() {
      if (disposing) return role;
      if (role === "owner") return role;
      const locks = options.locks;
      if (!locks) {
        // 无 Web Locks：单标签页 owner（不声称跨标签页互斥）。
        setRole("owner");
        return role;
      }
      // `locks.request` 的返回 promise 只会在锁释放后 settle（回调持锁等待 release）。
      // claim 必须在取得/放弃锁的**决定**完成后立即返回，否则会阻塞调用方（服务 start）
      // 的后续装配；锁生命周期由独立的 hold promise 保持到 release/dispose。
      let settled = false;
      let resolveDecided: (next: ReminderRole) => void = () => {};
      const decided = new Promise<ReminderRole>((resolve) => {
        resolveDecided = resolve;
      });
      const settle = (next: ReminderRole) => {
        if (settled) return;
        settled = true;
        if (next === "owner") {
          lockHeld = true;
          setRole("owner");
        } else if (!disposing) {
          setRole("standby");
        }
        resolveDecided(next);
      };
      const hold = new Promise<void>((resolve) => {
        releaseWaiters.add(resolve);
      });
      locks
        .request(`woohaa-task-notifications:${options.key}`, { ifAvailable: true }, (lock) => {
          if (lock === null || lock === undefined) {
            settle("standby");
            return Promise.resolve();
          }
          // 取得锁：本页是 owner；锁保持到 release/dispose，但 claim 不再等它。
          settle("owner");
          return hold;
        })
        .then(() => settle("standby"))
        .catch(() => settle("standby"));
      return decided;
    },
    async release() {
      for (const resolve of releaseWaiters) resolve();
      releaseWaiters.clear();
      lockHeld = false;
      setRole("standby");
    },
    setPeerForeground(next) {
      if (peerForeground === next) return;
      peerForeground = next;
      channel?.postMessage({ type: next ? "foreground" : "background", at: now() } satisfies ReminderMessage);
      publish();
    },
    isPeerForeground: () => peerForeground,
    dispose() {
      disposing = true;
      for (const resolve of releaseWaiters) resolve();
      releaseWaiters.clear();
      channel?.close();
      listeners.clear();
    }
  };
}

/** 广播本页前后台状态（供其它标签页抑制后台提醒）。 */
export function broadcastForeground(
  coordinator: ReminderCoordinator,
  foreground: ForegroundState,
  onChange: (background: boolean) => void
): () => void {
  const update = () => {
    const background = foreground.isBackground();
    coordinator.setPeerForeground(!background);
    onChange(background);
  };
  const unsubscribe = foreground.subscribe(update);
  update();
  return unsubscribe;
}
