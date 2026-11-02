/**
 * 宿主连通性（change: 2026-10-21-harden-extension-fault-isolation，design D6）。
 *
 * App 级单例：聚合「宿主 HTTP 可达性」与「画布会话 transport 断开」两类信号，给出
 * `online | reconnecting | restarted`：
 * - `reconnecting`：宿主不可达（受控重启、崩溃被拉起、网络中断）。全局遮罩显示「正在重新连接本机服务…」，
 *   提交类操作应据 `blocksSubmissions()` 拒绝；**不卸载画布**，Yjs 由 transport 自身重连补齐。
 * - 恢复后读一次 `/extension-releases/current.json`：releaseId 与本页固定的一致 → 回到 `online`；
 *   不一致 → `restarted`（非阻断提示「扩展已更新，重新打开画布以加载」），用户确认后只重建 Canvas scope。
 *
 * 探测按退避重试（1s → 2s → 4s … 上限 15s），宿主长时间不可达时一直保持 `reconnecting`，
 * 不伪造在线状态。只有失败信号进来才开始探测；在线时不轮询。
 */

export type HostConnectivityPhase = "online" | "reconnecting" | "restarted";

export type HostConnectivitySnapshot = {
  phase: HostConnectivityPhase;
  /** 进入 reconnecting 后的探测次数（展示用）。 */
  attempts: number;
  /** 恢复后观察到的新 releaseId（仅 `restarted`）。 */
  nextReleaseId: string | null;
  /** 新发布目录的逻辑地址（仅 `restarted`；供重开画布前重新固定）。 */
  nextReleaseHref?: string | null;
};

export type HostProbeResult =
  | { reachable: true; releaseId: string | null; href?: string | null }
  | { reachable: false };

export type HostConnectivityOptions = {
  /** 探测宿主：可达时返回当前发布 releaseId（无发布目录为 null）。 */
  probe: () => Promise<HostProbeResult>;
  /** 本页启动时固定的 releaseId（未加载目录为 null，此时不比较）。 */
  pinnedReleaseId: () => string | null;
  /** 先固定新发布目录、再只重建 Canvas scope（`restarted` 时由用户确认触发）。 */
  reopenCanvas?: (next: { releaseId: string | null; href: string | null }) => Promise<void> | void;
  /** 连续多少次 HTTP 失败才进入 reconnecting（缺省 2，避免单次抖动闪遮罩）。 */
  failureThreshold?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type HostConnectivityService = {
  getSnapshot(): HostConnectivitySnapshot;
  subscribe(listener: () => void): () => void;
  /** 宿主 HTTP 请求结果（网络失败 / 502 / 503 视为失败）。 */
  reportHttp(ok: boolean): void;
  /** 画布会话 transport 断开（closed）/ 打开（open）。 */
  reportTransport(status: "open" | "closed"): void;
  /** 直接进入 reconnecting（例如本页刚发起受控重启）。 */
  expectRestart(): void;
  /** reconnecting 期间应阻止提交类操作。 */
  blocksSubmissions(): boolean;
  /** `restarted` 提示：确认后只重建 Canvas scope。 */
  reopenCanvas(): Promise<void>;
  /** `restarted` 提示：暂不重开，收起提示（本页继续用旧 release）。 */
  dismissRestarted(): void;
  /**
   * 宿主仍在线但发布目录已切换（受管扩展升级/卸载，change: 2026-10-21-add-extension-marketplace-point）：
   * 进入同一个 `restarted` 提示路径，之后的 `reopenCanvas()` 先 repin 新 release 再只重建 Canvas scope。
   * 重连中不打断（恢复后探测会给出最新 release）；与本页固定的 releaseId 相同则忽略。
   */
  offerRelease(next: { releaseId: string; href: string }): void;
  dispose(): void;
};

const ONLINE: HostConnectivitySnapshot = { phase: "online", attempts: 0, nextReleaseId: null };

export function createHostConnectivityService(options: HostConnectivityOptions): HostConnectivityService {
  const threshold = Math.max(1, options.failureThreshold ?? 2);
  const initialBackoff = options.initialBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 15_000;
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let snapshot: HostConnectivitySnapshot = ONLINE;
  let consecutiveFailures = 0;
  let timer: unknown = null;
  let probing = false;
  let disposed = false;
  /** 本次 reconnecting 的代次：迟到的探测结果不覆盖新状态。 */
  let generation = 0;

  const publish = (next: HostConnectivitySnapshot) => {
    if (
      next.phase === snapshot.phase &&
      next.attempts === snapshot.attempts &&
      next.nextReleaseId === snapshot.nextReleaseId &&
      (next.nextReleaseHref ?? null) === (snapshot.nextReleaseHref ?? null)
    ) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const schedule = (delay: number) => {
    if (disposed || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void runProbe();
    }, delay);
  };

  const backoffFor = (attempts: number) => Math.min(maxBackoff, initialBackoff * 2 ** Math.max(0, attempts - 1));

  const runProbe = async () => {
    if (disposed || probing || snapshot.phase !== "reconnecting") return;
    probing = true;
    const current = generation;
    const attempts = snapshot.attempts + 1;
    publish({ ...snapshot, attempts });
    let result: HostProbeResult;
    try {
      result = await options.probe();
    } catch {
      result = { reachable: false };
    }
    probing = false;
    if (disposed || current !== generation || snapshot.phase !== "reconnecting") return;
    if (!result.reachable) {
      schedule(backoffFor(attempts));
      return;
    }
    consecutiveFailures = 0;
    const pinned = options.pinnedReleaseId();
    if (pinned !== null && result.releaseId !== null && result.releaseId !== pinned) {
      publish({ phase: "restarted", attempts: 0, nextReleaseId: result.releaseId, nextReleaseHref: result.href ?? null });
      return;
    }
    publish(ONLINE);
  };

  /**
   * HTTP 失败只说明**某个接口**失败；先探活再决定是否进入重连。
   *
   * 扩展/业务接口自身返回 502/503（例如未就绪的录制执行器、轮询中的 OAuth 状态）
   * 不代表宿主不可达。此前任何同源请求失败都直接累计到重连阈值，导致这些接口轮询时
   * 反复闪「正在重新连接本机服务…」。探活通过就清空计数，宿主真不可达时探活失败再
   * 进入原有退避重连。
   */
  const verifyReachability = async () => {
    if (disposed || probing) return;
    probing = true;
    const current = generation;
    let result: HostProbeResult;
    try {
      result = await options.probe();
    } catch {
      result = { reachable: false };
    }
    probing = false;
    if (disposed || current !== generation || snapshot.phase !== "online") return;
    if (!result.reachable) {
      consecutiveFailures = 0;
      enterReconnecting();
      return;
    }
    consecutiveFailures = 0;
    const pinned = options.pinnedReleaseId();
    if (pinned !== null && result.releaseId !== null && result.releaseId !== pinned) {
      publish({ phase: "restarted", attempts: 0, nextReleaseId: result.releaseId, nextReleaseHref: result.href ?? null });
    }
  };

  const enterReconnecting = () => {
    if (disposed || snapshot.phase === "reconnecting") return;
    generation += 1;
    publish({ phase: "reconnecting", attempts: 0, nextReleaseId: null });
    schedule(initialBackoff);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportHttp(ok) {
      // 探活请求自身也会经过同源 fetch 观察器；不能让它反向触发新的探活。
      if (probing) return;
      if (ok) {
        consecutiveFailures = 0;
        return;
      }
      if (snapshot.phase !== "online") return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold) void verifyReachability();
    },
    reportTransport(status) {
      // transport 打开不代表 HTTP 面就绪，恢复仍以探测结果为准；断开是强信号，直接进入重连。
      if (status === "closed") enterReconnecting();
    },
    expectRestart: enterReconnecting,
    blocksSubmissions: () => snapshot.phase === "reconnecting",
    async reopenCanvas() {
      if (snapshot.phase !== "restarted") return;
      const next = { releaseId: snapshot.nextReleaseId, href: snapshot.nextReleaseHref ?? null };
      publish(ONLINE);
      await options.reopenCanvas?.(next);
    },
    dismissRestarted() {
      if (snapshot.phase === "restarted") publish(ONLINE);
    },
    offerRelease(next) {
      if (disposed || snapshot.phase === "reconnecting") return;
      if (next.releaseId === options.pinnedReleaseId()) return;
      publish({ phase: "restarted", attempts: 0, nextReleaseId: next.releaseId, nextReleaseHref: next.href });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      listeners.clear();
    }
  };
}

/** 发布目录发现端点（逻辑路径，出口加挂载前缀）。 */
export const HOST_RELEASE_DISCOVERY_PATH = "/extension-releases/current.json";

/**
 * 缺省探测：读 `/extension-releases/current.json`。200 → 可达并带 releaseId；404 → 可达但无发布目录；
 * 网络失败与 5xx（ingress 在后端不可达时回 502/503）→ 不可达。
 */
export function createReleaseDiscoveryProbe(fetchImpl: typeof globalThis.fetch): () => Promise<HostProbeResult> {
  return async () => {
    try {
      const response = await fetchImpl(HOST_RELEASE_DISCOVERY_PATH, { cache: "no-store", credentials: "same-origin" });
      if (response.status >= 500) return { reachable: false };
      if (!response.ok) return { reachable: true, releaseId: null };
      const body = (await response.json().catch(() => null)) as { releaseId?: unknown; href?: unknown } | null;
      return {
        reachable: true,
        releaseId: typeof body?.releaseId === "string" ? body.releaseId : null,
        href: typeof body?.href === "string" ? body.href : null
      };
    } catch {
      return { reachable: false };
    }
  };
}
