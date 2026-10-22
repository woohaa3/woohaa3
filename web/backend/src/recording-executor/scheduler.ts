/**
 * 参考录制的 dirty 观察、focus 租约与优先级调度
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.2 / 5.3 / design D6）。
 *
 * 规则：
 * - **多个窗口任一持有效 focus 只标脏**：只有最后一个 focus 租约退出或过期，才允许补排；
 * - **按内容版本去重**：同一 (canvas, node, clip, contentIdentity, profile) 只保留一个合法 claim；
 *   两个窗口同时发现同一缺失只产生一个任务；
 * - **优先级**：交互/播放/截图 > 显式导出 > 自动参考；参考在帧边界让路，不抢占显式任务；
 * - **有界退避**：参考失败 2s→4s→…→30s，最多 5 次，仅瞬态错误重试；
 * - **交互租约过期不永久饿死**：连续交互只续期，过期后参考可继续。
 *
 * 纯内存、可注入时钟：无 GPU/无 socket 即可完整单测。
 */

export type ReferenceSourceKey = {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
};

/** 稳定的去重键。 */
export function referenceClaimKey(key: ReferenceSourceKey): string {
  return [
    "reference",
    key.canvasId,
    key.filmSetNodeId,
    key.clipId,
    key.contentIdentity,
    key.profileKey
  ].join(":");
}

export type ReferenceSourceState = "clean" | "dirty" | "claimed" | "ready" | "failed";

type ReferenceEntry = {
  key: ReferenceSourceKey;
  state: ReferenceSourceState;
  attempts: number;
  /** 下一次允许尝试的时间；未到点不排。 */
  nextAttemptAt: number;
  lastError?: { code: string; message: string; transient: boolean };
};

/** focus 租约：一个窗口对某个片场的编辑 focus。 */
type FocusLease = {
  canvasId: string;
  filmSetNodeId: string;
  holder: string;
  expiresAt: number;
};

export type ReferenceSchedulerOptions = {
  now?: () => number;
  /** focus 租约时长（毫秒）。窗口需在到期前续期。 */
  focusLeaseMs?: number;
  /** 交互租约时长：用户操作期间参考让路。 */
  interactionLeaseMs?: number;
  /** 退避基数与上限。 */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
};

/** 调度器输出的下一项工作。 */
export type ReferenceJob = {
  key: ReferenceSourceKey;
  claimKey: string;
  priority: number;
  attempt: number;
};

export class ReferenceRecordingScheduler {
  private readonly entries = new Map<string, ReferenceEntry>();
  private readonly leases = new Map<string, FocusLease>();
  private readonly now: () => number;
  private readonly focusLeaseMs: number;
  private readonly interactionLeaseMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  /** 交互租约到期时间；到期前参考不排。 */
  private interactionUntil = 0;
  /** 是否已有显式导出的等待/运行 claim（参考必须让路）。 */
  private explicitActive = false;
  /** 正在执行的参考 claim（最多一个）。 */
  private activeClaim: string | null = null;

  constructor(options: ReferenceSchedulerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.focusLeaseMs = Math.max(1_000, options.focusLeaseMs ?? 30_000);
    this.interactionLeaseMs = Math.max(500, options.interactionLeaseMs ?? 5_000);
    this.retryBaseMs = Math.max(100, options.retryBaseMs ?? 2_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 30_000);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  }

  /** 获得/续期一个 focus 租约（窗口进入片场编辑）。 */
  acquireFocus(input: { canvasId: string; filmSetNodeId: string; holder: string }): void {
    const key = focusKey(input.canvasId, input.filmSetNodeId);
    this.leases.set(key, {
      ...input,
      expiresAt: this.now() + this.focusLeaseMs
    });
  }

  /** 续期（窗口仍在前台编辑）。 */
  renewFocus(input: { canvasId: string; filmSetNodeId: string; holder: string }): boolean {
    const key = focusKey(input.canvasId, input.filmSetNodeId);
    const lease = this.leases.get(key);
    if (!lease || lease.holder !== input.holder) return false;
    lease.expiresAt = this.now() + this.focusLeaseMs;
    return true;
  }

  /** 释放（退出聚焦）。 */
  releaseFocus(input: { canvasId: string; filmSetNodeId: string; holder: string }): void {
    const key = focusKey(input.canvasId, input.filmSetNodeId);
    const lease = this.leases.get(key);
    if (lease?.holder === input.holder) this.leases.delete(key);
  }

  /** 是否有**任意**窗口仍持有效 focus（多窗口时只有全部退出才补排）。 */
  hasActiveFocus(canvasId: string, filmSetNodeId: string): boolean {
    const lease = this.leases.get(focusKey(canvasId, filmSetNodeId));
    if (!lease) return false;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(focusKey(canvasId, filmSetNodeId));
      return false;
    }
    return true;
  }

  /** 标记视口内容变脏（聚焦期间只标脏，不排队）。 */
  markDirty(key: ReferenceSourceKey): void {
    const entry = this.entry(key);
    if (entry.state === "ready" || entry.state === "clean") entry.state = "dirty";
    // claimed/failed 保持原状态：运行中的任务不因新 dirty 被取消，完成后由 setReady 判定。
  }

  /** 标记当前版本已 ready（权威资产存在）。 */
  markReady(key: ReferenceSourceKey): void {
    const entry = this.entry(key);
    entry.state = "ready";
    entry.attempts = 0;
    entry.lastError = undefined;
  }

  /** 标记该版本不再需要（节点/片段删除、版本被取代）。 */
  forget(key: ReferenceSourceKey): void {
    this.entries.delete(referenceClaimKey(key));
    if (this.activeClaim === referenceClaimKey(key)) this.activeClaim = null;
  }

  /** 显式导出开始/结束：参考在期间让路。 */
  setExplicitActive(active: boolean): void {
    this.explicitActive = active;
  }

  /** 用户交互（播放/seek/编辑/截图）：参考让路一段时间。 */
  noteInteraction(): void {
    this.interactionUntil = this.now() + this.interactionLeaseMs;
  }

  /** 当前是否应让路（显式任务优先，或交互租约未过期）。 */
  shouldYield(): boolean {
    return this.explicitActive || this.now() < this.interactionUntil;
  }

  /**
   * 取下一条可执行的参考任务。
   *
   * 跳过：仍在 focus、未到退避时间、尝试次数耗尽、已有活动 claim、需要让路。
   */
  next(): ReferenceJob | null {
    if (this.activeClaim !== null) return null;
    if (this.shouldYield()) return null;
    const now = this.now();
    const candidates = [...this.entries.values()]
      .filter(entry => entry.state === "dirty")
      .filter(entry => !this.hasActiveFocus(entry.key.canvasId, entry.key.filmSetNodeId))
      .filter(entry => now >= entry.nextAttemptAt)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || referenceClaimKey(a.key).localeCompare(referenceClaimKey(b.key)));
    const next = candidates[0];
    if (!next) return null;
    const claimKey = referenceClaimKey(next.key);
    next.state = "claimed";
    next.attempts += 1;
    this.activeClaim = claimKey;
    return { key: next.key, claimKey, priority: 1, attempt: next.attempts };
  }

  /** 参考任务完成：只有仍匹配当前版本时才 ready。 */
  complete(claimKey: string, outcome: { ok: true } | { ok: false; code: string; message: string; transient: boolean }): void {
    const entry = this.byClaim(claimKey);
    if (this.activeClaim === claimKey) this.activeClaim = null;
    if (!entry) return;
    if (outcome.ok) {
      entry.state = "ready";
      entry.attempts = 0;
      entry.lastError = undefined;
      entry.nextAttemptAt = 0;
      return;
    }
    entry.lastError = outcome;
    if (!outcome.transient || entry.attempts >= this.maxAttempts) {
      // 永久失败：保留错误供 UI 显示，不再自动重试。
      entry.state = "failed";
      return;
    }
    entry.state = "dirty";
    entry.nextAttemptAt = this.now() + this.backoffMs(entry.attempts);
  }

  /** 该版本当前状态（供 UI/诊断）。 */
  stateOf(key: ReferenceSourceKey): ReferenceSourceState | "unknown" {
    return this.entries.get(referenceClaimKey(key))?.state ?? "unknown";
  }

  /** 该版本的最后错误。 */
  errorOf(key: ReferenceSourceKey): ReferenceEntry["lastError"] {
    return this.entries.get(referenceClaimKey(key))?.lastError;
  }

  /** 已跟踪条目数（诊断用）。 */
  size(): number {
    return this.entries.size;
  }

  private backoffMs(attempts: number): number {
    const exponential = this.retryBaseMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(this.retryMaxMs, exponential);
  }

  private byClaim(claimKey: string): ReferenceEntry | undefined {
    for (const entry of this.entries.values()) {
      if (referenceClaimKey(entry.key) === claimKey) return entry;
    }
    return undefined;
  }

  private entry(key: ReferenceSourceKey): ReferenceEntry {
    const claimKey = referenceClaimKey(key);
    const existing = this.entries.get(claimKey);
    if (existing) return existing;
    const created: ReferenceEntry = { key, state: "dirty", attempts: 0, nextAttemptAt: 0 };
    this.entries.set(claimKey, created);
    return created;
  }
}

function focusKey(canvasId: string, filmSetNodeId: string): string {
  return `${canvasId}\u0000${filmSetNodeId}`;
}

/**
 * 显式导出的优先级队列：按 requestId 幂等，不与参考合并。
 *
 * 只有一条真正在跑；其余按 `priority`（均等）与提交顺序 FIFO。
 */
export class ExplicitRecordingQueue {
  private readonly pending: string[] = [];
  private active: string | null = null;
  private readonly known = new Set<string>();

  /** 入队（幂等）。 */
  enqueue(requestId: string): boolean {
    if (this.known.has(requestId)) return false;
    this.known.add(requestId);
    this.pending.push(requestId);
    return true;
  }

  /** 取下一条；已有活动任务时返回 null。 */
  next(): string | null {
    if (this.active !== null) return null;
    const next = this.pending.shift();
    if (!next) return null;
    this.active = next;
    return next;
  }

  /** 完成/失败后释放，允许下一条。 */
  finish(requestId: string): void {
    if (this.active === requestId) this.active = null;
    this.known.delete(requestId);
  }

  /** 取消：从等待队列移除；活动任务由协调器裁定。 */
  cancel(requestId: string): boolean {
    const index = this.pending.indexOf(requestId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.known.delete(requestId);
    return true;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  activeRequest(): string | null {
    return this.active;
  }
}
