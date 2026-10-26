/**
 * 站点侧的画布会话接线
 * （change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 时序逻辑（IndexedDB → Store → 渲染）在 `canvas/state` 与 `canvas/` 的纯模块里，
 * 这里只负责 DOM / `window` 适配：
 *
 * - Web → Bevy：由 `interaction-controller` 每帧最多调用一次 `set_scene`；
 * - 命令：交互控制器直接通过 `CanvasSession.submitCommands()` 提交服务端语义命令；
 * - 持久化只有一条路径：**服务端 Yjs room**。Store 由 published Y.Doc 派生，断线即只读。
 *
 * 已删除 Godot bridge：不再有 frame buffer、`canvasPushFrame`、`canvasBridgeCommand`、
 * `canvas-runtime-ready` 或投影 coordinator。
 */
import { CommandLifecycleRegistry, CanvasDatabase, IndexedDbYjsCacheRepository, WorkingProjectionStore, applyYjsCacheToDoc, createCanonicalProjectionCache, validateYjsCache, woohaa3CanvasStore, type CanvasSyncStatus } from "./canvas-state/index.js";
import * as Y from "yjs";
import type { CanvasAccess, CanvasCommand, ServerCanvas, TelemetryEventInput } from "@woohaa3/contracts";
import { yDocToServerCanvas, YJS_SYNC_PROTOCOL_VERSION, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { ReadonlyCanvasProvider, type ReadonlyProviderState } from "./yjs/readonly-provider.js";
import type { CanvasSession, CanvasSessionStatus } from "../contracts.js";
import type { CanvasRemoteService } from "../contracts.js";
import { activeTelemetryClient, beginStartupSpan, stableTelemetryErrorCode, telemetryNow, type TelemetryClient } from "./telemetry-primitives.js";

export type { CanvasSession, CanvasSessionStatus } from "../contracts.js";

// 页面级编辑历史 Service 与画布 store 由本模块再导出，供 install-services 从同一入口取用
// （change: 2026-10-09-improve-canvas-workflow，任务 1.5）。
export { createCanvasEditService } from "./canvas-state/index.js";
export type { CanvasEditService, CanvasEditSnapshot } from "./canvas-state/index.js";
import type { CanvasEditService } from "./canvas-state/index.js";
export { woohaa3CanvasStore } from "./canvas-state/index.js";

/** 第一阶段只维护一个画布，ID 固定；多画布切换属于后续能力。 */
export const DEFAULT_CANVAS_ID = "woohaa3-default-canvas";

/**
 * 页面级调试/test 钩子：把会话命令出口挂到 `window.__canvasSubmitCommands`，供 E2E 直接
 * 提交语义命令（等价于交互控制器完成一次手势）。生产无副作用。
 */
export function installCanvasSessionTestHooks(session: CanvasSession): void {
  const target = globalThis as unknown as {
    __canvasSubmitCommands?: (commands: CanvasCommand[], commandId?: string) => { ok: boolean; reason?: string };
    __canvasIsWritable?: () => boolean;
  };
  target.__canvasSubmitCommands = (commands, commandId) => {
    const id = commandId ?? `e2e-${Date.now().toString(36)}-${testSeq++}`;
    const result = session.submitCommands(commands, id);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  };
  target.__canvasIsWritable = () => session.isWritable();
  // E2E 观察同步状态（含断线只读相位）。
  const mirror = (status: CanvasSessionStatus) => {
    (globalThis as unknown as { __canvasSessionStatus?: unknown }).__canvasSessionStatus = status;
  };
  mirror(session.getStatus());
  session.subscribe(mirror);
  // 供 E2E 断言 working projection 与 canonical 的分离（生产无副作用）。
  (globalThis as unknown as { __canvasStoreState?: unknown }).__canvasStoreState = () =>
    woohaa3CanvasStore.getState();
}

/**
 * 页面级调试/test 钩子：暴露编辑历史（撤销/重做、记录、冲突跳过）供 E2E 驱动
 * （change: 2026-10-09-improve-canvas-workflow，任务 7.1）。生产无副作用。
 */
export function installCanvasEditTestHooks(edit: CanvasEditService): void {
  const target = globalThis as unknown as {
    __canvasEdit?: {
      record: (commands: readonly CanvasCommand[], label: string) => Promise<{ ok: boolean; reason?: string }>;
      recordParameter: (input: { nodeId: string; modelKey: string; before: Record<string, unknown>; after: Record<string, unknown>; label: string }) => void;
      undo: () => Promise<{ ok: boolean; reason?: string }>;
      redo: () => Promise<{ ok: boolean; reason?: string }>;
      snapshot: () => unknown;
      skipConflict: (entryId: string) => boolean;
    };
  };
  target.__canvasEdit = {
    async record(commands, label) {
      const result = await edit.record(commands, label);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    recordParameter(input) {
      edit.recordParameter({
        label: input.label,
        nodeId: input.nodeId,
        modelKey: input.modelKey,
        before: input.before,
        after: input.after,
        apply: () => undefined
      });
    },
    undo: () => edit.undo(),
    redo: () => edit.redo(),
    snapshot: () => {
      const snapshot = edit.getSnapshot();
      return {
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
        size: snapshot.size,
        undoLabel: snapshot.undoLabel,
        redoLabel: snapshot.redoLabel,
        lastAction: snapshot.lastAction
      };
    },
    skipConflict: (entryId) => edit.skipConflict(entryId)
  };
}

let testSeq = 0;


/** 同步尚未建立时的 Yjs 状态（正在连接远程）。 */
const IDLE_REMOTE: CanvasSyncStatus = {
  mode: "remote",
  phase: "syncing",
  confirmedRevision: null,
  pendingCount: 0,
  error: null
};

/**
 * 浏览器是否处于系统级断网。
 *
 * Chromium 的 `page.context().setOffline(true)` 不会关闭已建立的 WebSocket，因此仅靠
 * socket 的 close 事件无法感知断网。这里读 `navigator.onLine`——它是产品语义（断线只读）
 * 的正确来源，E2E 与真实用户断网都会置为 false。
 */
function isBrowserOffline(): boolean {
  const online = (globalThis as unknown as { navigator?: { onLine?: boolean } }).navigator?.onLine;
  return online === false;
}

export type CreateCanvasSessionOptions = {
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  canvasId?: string;
  /** Canvas 远端 adapter；会话在其上维护投影与写入门禁。 */
  remote: CanvasRemoteService;
  /** 注入数据库（测试用）；默认按 `globalThis.indexedDB` 打开。 */
  database?: CanvasDatabase;
  /**
   * 本地发布缓存的 identity provider + subject 命名空间
   * （change: 2026-10-13-...，任务 5.8）。省略时按 canvasId 缓存（测试/无身份扩展）。
   * 返回值 null 表示未知/匿名，退化为 `anonymous:<canvasId>`，展示仍受授权门禁保护。
   */
  cacheNamespace?: () => string | null;
  /**
   * 遥测采集客户端（可选；change: 2026-10-20-add-local-client-telemetry，任务 4.2）。
   *
   * 省略时回退到 App scope 安装的客户端；两者都不存在则埋点整体 no-op。**不**硬依赖：
   * 遥测不是画布启动的前置条件（插件/测试可以只创建会话）。
   */
  telemetry?: TelemetryClient;
  /**
   * 宿主重连门禁（change: 2026-10-21-harden-extension-fault-isolation，D6）：返回 true 时宿主正在重连
   * （受控重启/掉线），`submitCommands` 立即返回可重试失败 `host-reconnecting`，不进入 pending、不发送。
   */
  blocksSubmissions?: () => boolean;
  /**
   * 显式重连等待 provider 结算（ready/error）的上限（毫秒，默认 8s）。
   *
   * 超时只清「重建中」并保留只读，不谎称已连接；测试注入较短值。
   */
  reconnectTimeoutMs?: number;
  /**
   * 调用者在这张画布上的内容权限（服务端判定；省略/null = 未知，按可写处理）。
   *
   * 必须随**打开画布**一起解析：只读提示要出现在进入画布这一步，而不是等第一次服务端
   * 写入（生成/存储）被拒绝才暴露。`canWrite=false` 时会话整体只读：`isWritable()`
   * 为 false（生成/编辑/粘贴等入口按它置灰），`submitCommands` 直接结构化拒绝。
   */
  access?: CanvasAccess | null;
};

/** 宿主重连期间拒绝提交的稳定失败码；调用方据此提示「稍后重试」，命令没有被发送或丢弃到队列。 */
export const HOST_RECONNECTING_SUBMIT_CODE = "host-reconnecting";

/**
 * 创建一个画布会话。**不**使用模块级单例：生命周期由页面级 Plugin 拥有，
 * 必须能被 dispose 并重新创建（design D2/D7）。
 */
export async function createCanvasSession(options: CreateCanvasSessionOptions): Promise<CanvasSession> {
  const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
  const remote = options.remote;
  const database = options.database ?? new CanvasDatabase();

  /**
   * 权限只读：服务端说这个账号写不了这张画布。
   *
   * 与断线只读区分开——断线是"暂时连不上"，这里是"本来就没有写权限"，重连也不会变。
   * 没有权限答案（`null`/`undefined`）时**不**判只读：旧服务端、纯本地画布都走这条，
   * 把未知当只读会让所有本地画布突然不可编辑。
   */
  const access = options.access ?? null;
  const readOnly = access !== null && !access.canWrite;
  const readOnlyReason = readOnly
    ? access !== null && !access.canRead
      ? "你在服务端没有这张画布的访问权限，本机内容是之前的副本、修改不会被保存。"
      : "你对这张画布只有只读权限，修改不会被保存。"
    : null;

  let status: CanvasSessionStatus = {
    phase: "loading",
    error: null,
    hydrated: false,
    remote: { ...IDLE_REMOTE, readOnly, readOnlyReason }
  };
  const listeners = new Set<(status: CanvasSessionStatus) => void>();
  const publish = (patch: Partial<CanvasSessionStatus>) => {
    status = { ...status, ...patch };
    for (const listener of listeners) listener(status);
  };

  /**
   * 显式重连 / 浏览器恢复联网的重建是否仍在进行
   * （change: 2026-10-21-recover-canvas-connection-explicitly）。
   *
   * 发布到 `remote.reconnecting`，状态气泡里的「重新连接」按钮据此置灰。
   */
  let reconnecting = false;
  /** provider 相位变化序号与等待者：重连要等「本次」相位结算，不能拿旧相位当结果。 */
  let providerPhaseSeq = 0;
  const providerPhaseWaiters = new Set<() => void>();
  const notifyProviderPhaseChanged = (): void => {
    providerPhaseSeq += 1;
    for (const waiter of [...providerPhaseWaiters]) waiter();
  };
  /** 发布「正在重建」标记；`message` 省略表示不动错误文案（传 null 表示清空）。 */
  const setReconnecting = (busy: boolean, message?: string | null): void => {
    reconnecting = busy;
    publish({
      ...(message !== undefined ? { error: message } : {}),
      remote: {
        ...status.remote,
        ...(message !== undefined ? { error: message } : {}),
        reconnecting: busy
      }
    });
  };

  // —— 遥测埋点（可选；change: 2026-10-20-add-local-client-telemetry，design D3/D7）——
  // 硬约束：埋点不得进入业务路径。`record()` 同步返回、不 await、不抛错；客户端缺失即 no-op。
  const sessionStartedAt = telemetryNow();
  /**
   * 会话打开阶段（`perf.startup` / `session-open`）：
   * change: 2026-10-25-enhance-telemetry-performance-collection，task 3.4。
   *
   * 与 `canvas.open` 刻意分开：后者是"用户打开画布这件事"的成败与总耗时，这条只回答
   * "会话建立这一段墙钟走了多久"，两个口径都能被独立对比。
   */
  const finishSessionOpen = beginStartupSpan("session-open");
  const telemetry = (): TelemetryClient | undefined => options.telemetry ?? activeTelemetryClient();
  const recordTelemetry = (input: TelemetryEventInput): void => {
    try {
      telemetry()?.record(input);
    } catch {
      // 防御：任何埋点异常都不得影响画布生命周期。
    }
  };
  const elapsedMs = (startedAt: number): number => Math.max(0, Math.round(telemetryNow() - startedAt));
  /** `canvas.open` 每个会话只观测首次打开（retry 属于重新打开，不重复计首屏）。 */
  let openSettled = false;
  let syncStartedAt = sessionStartedAt;
  let syncSettled = false;
  const settleOpen = (result: "success" | "failure" | "cancelled", errorCode?: string): void => {
    if (openSettled) return;
    openSettled = true;
    finishSessionOpen(result === "success" ? "success" : "failure");
    recordTelemetry({
      name: "canvas.open",
      result,
      origin: "browser",
      durationMs: elapsedMs(sessionStartedAt),
      ...(errorCode === undefined ? {} : { errorCode })
    });
  };
  const settleSync = (result: "success" | "failure" | "cancelled", errorCode?: string): void => {
    if (syncSettled) return;
    syncSettled = true;
    recordTelemetry({
      name: "sync.connect",
      result,
      origin: "browser",
      surface: "sync",
      durationMs: elapsedMs(syncStartedAt),
      ...(errorCode === undefined ? {} : { errorCode })
    });
  };

  /** 只读同步 provider（唯一持久化路径）。 */
  let yjsProvider: ReadonlyCanvasProvider | undefined;
  let yjsLifecycle: CommandLifecycleRegistry | undefined;
  const saveStarts = new Map<string, number>();
  const settleSave = (commandId: string, result: "success" | "failure" | "cancelled", errorCode?: string) => {
    const started = saveStarts.get(commandId);
    if (started === undefined) return;
    saveStarts.delete(commandId);
    recordTelemetry({ name: "canvas.save", result, origin: "browser", surface: "sync",
      durationMs: elapsedMs(started), ...(errorCode ? { errorCode } : {}) });
  };
  /** 会话内 working projection：canonical + 有序 pending batches，仅内存。 */
  const projection = new WorkingProjectionStore(options.lifecycle);
  /**
   * 规范投影复用缓存（change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 8.1）。
   *
   * provider 的状态通知远多于内容变化；同一 doc/epoch/revision/doc版本 连续到达时直接复用
   * 已验证投影，不重复全量排序与完整性校验。换画布、换 epoch、换本地 doc 或派生失败都使
   * 缓存失效（失败不进缓存，损坏状态必须每次重新报告）。
   */
  const canonicalProjection = createCanonicalProjectionCache<ServerCanvas>();
  /** 每个应用的服务端 update 递增；覆盖「revision 未变但内容已变」的合并写入。 */
  let canonicalDocVersion = 0;

  let offlineListener: (() => void) | undefined;
  let onlineListener: (() => void) | undefined;
  let disposed = false;
  /** 显式重连等待上限：连接迟迟不恢复时不谎称已连接。 */
  const reconnectTimeoutMs = options.reconnectTimeoutMs ?? 8_000;
  /** 进行中的显式重连（幂等：并发调用共享同一次重建，不叠加连接）。 */
  let reconnectInFlight: Promise<void> | null = null;

  /**
   * 等待 provider 到达 ready/error 或超时。
   *
   * 只认「开始重建之后」的相位变化（`providerPhaseSeq`）：重建前可能已经停在 error，
   * 直接读相位会把旧的失败当成本次结果。
   */
  const waitForProviderSettled = (startSeq: number): Promise<"ready" | "error" | "timeout"> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: "ready" | "error" | "timeout") => {
        if (settled) return;
        settled = true;
        providerPhaseWaiters.delete(check);
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      const check = () => {
        if (providerPhaseSeq <= startSeq) return;
        const phase = yjsProvider?.providerState.phase;
        if (phase === "ready") finish("ready");
        else if (phase === "error") finish("error");
      };
      timer = setTimeout(() => finish("timeout"), reconnectTimeoutMs);
      providerPhaseWaiters.add(check);
      // 注册后立即检查一次：重建期间相位可能已经变化（例如 attach 已同步完成）。
      check();
    });

  const detach = () => {
    for (const commandId of saveStarts.keys()) settleSave(commandId, "cancelled");
    yjsProvider?.dispose();
    yjsProvider = undefined;
    yjsLifecycle = undefined;
    // page-owned Canvas Session 由本 session 拥有：detach 时关闭物理连接，
    // 避免切换画布/dispose 后旧 scope 的 socket 泄漏（change: unify-canvas-session-websocket）。
    remote.closeCanvasSession();
    if (offlineListener && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("offline", offlineListener);
    }
    if (onlineListener && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("online", onlineListener);
    }
    offlineListener = undefined;
    onlineListener = undefined;
  };

  /**
   * 从当前 Y.Doc 派生规范聚合（Store 的唯一来源）。
   *
   * 复用身份取 provider 声明的 **doc + room epoch + revision + doc 版本**：provider 的状态
   * 通知（syncing/synced/权限/重连）远多于内容变化，同一事务内不重复做全量排序与完整性校验
   * （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 8.1）。
   * `canonicalDocVersion` 在每个服务端 update、换 doc/epoch 与丢弃本地缓存时递增，因此
   * 「revision 未变但内容已变」同样不复用；派生失败不入缓存，损坏状态每次都重新报告。
   */
  const deriveCanvas = (): ServerCanvas | null => {
    const provider = yjsProvider;
    if (!provider) return null;
    const key = {
      canvasId,
      roomEpoch: provider.providerState.roomEpoch,
      revision: provider.providerState.revision ?? -1,
      docVersion: canonicalDocVersion
    };
    try {
      // 派生失败时抛错：缓存只保存**已验证成功**的投影，损坏状态必须每次重新报告。
      const { value } = canonicalProjection.resolve(key, () => {
        const exported = yDocToServerCanvas(provider.doc);
        if (!exported.ok) throw new Error(`${exported.failure.code}: ${exported.failure.message}`);
        return exported.canvas;
      });
      return value;
    } catch {
      return null;
    }
  };

  /**
   * 把 provider 状态映射进会话状态。
   *
   * 断网门禁：浏览器 `offline` 期间即使底层 socket 尚未关闭，也必须按只读处理。
   */
  const applyYjsProviderState = (state: ReadonlyProviderState, lifecycle: CommandLifecycleRegistry) => {
    const offline = isBrowserOffline();
    const effectivePhase = offline && state.phase === "ready" ? "offline-readonly" : state.phase;
    const derived = deriveCanvas();
    // 授权门禁（change: 2026-10-13-...，任务 5.8 / design D10）：只在服务端权威握手（ready）后把
    // 派生状态发布到 UI。syncing/error/offline 期间即使本地缓存可派生也不展示旧缓存内容，直到
    // 服务器确认当前身份的读权限；断线只读沿用已发布的 canonical（不在此覆盖）。
    if (state.phase === "ready" && derived && derived !== projection.canonicalCanvas) {
      (globalThis as unknown as { __canvasCanonical?: unknown }).__canvasCanonical = derived;
      // canonical 变化后重基 working projection（effect satisfaction + 顺序重放）。
      projection.applyCanonical(derived);
      woohaa3CanvasStore.getState().applyRemoteCanvas(derived, projection.workingCanvas);
      // 已被 canonical 观察的批次 → lifecycle observed（update-first 场景）。
      for (const batch of projection.pendingBatches) {
        if (batch.state === "observed") lifecycle.observe(batch.commandId);
      }
    }

    // 首次打开/首个同步的既有相位各自对应一个终态（design D3）：就绪 / 错误 / 断线。
    // 首次连接失败会落到 `offline-readonly`（socket 关闭但尚未 ready），按 failure 记，
    // 而不是伪装成永久的"进行中"。已经 ready 后的掉线不重复计（settle 幂等）。
    if (effectivePhase === "ready" && derived) {
      settleSync("success");
      settleOpen("success");
    } else if (effectivePhase === "error") {
      const code = stableTelemetryErrorCode(state.error, "sync-error");
      settleSync("failure", code);
      settleOpen("failure", code);
    } else if (effectivePhase === "offline-readonly") {
      settleSync("failure", "offline");
      settleOpen("failure", "offline");
    }
    lifecycle.onDerivedRevisionChanged();
    const offlineMessage = "网络已断开，画布只读";
    const readyPhase = effectivePhase === "ready";
    publish({
      phase: effectivePhase === "error" ? "error" : "ready",
      error: state.error ?? (offline ? offlineMessage : null),
      remote: {
        mode: readyPhase ? "remote" : "offline",
        phase: readyPhase ? "synced" : effectivePhase === "offline-readonly" ? "offline" : "syncing",
        confirmedRevision: state.revision,
        pendingCount: projection.pendingBatches.length,
        error: offline ? offlineMessage : state.error,
        // 权限只读与链路状态正交：链路正常也可能只读（viewer/只读链接/非参与者）。
        readOnly,
        readOnlyReason,
        // 断线来源：浏览器整机断网 vs 只是这条会话连接被关闭；文案与恢复入口据此区分。
        offlineReason: readyPhase ? null : offline ? "browser-offline" : "session-closed",
        reconnecting
      }
    });
    notifyProviderPhaseChanged();
  };

  /** 断网时把会话标记为只读（即使底层 socket 尚未关闭）。 */
  const publishOffline = () => {
    if (!yjsProvider) return;
    const offlineMessage = "网络已断开，画布只读";
    publish({
      remote: {
        mode: "offline",
        phase: "offline",
        confirmedRevision: status.remote.confirmedRevision,
        pendingCount: projection.pendingBatches.length,
        error: offlineMessage,
        // 这是浏览器整机断网（不是画布服务关闭连接）：
        // 恢复入口的文案与状态气泡的措辞据此区分。
        offlineReason: "browser-offline",
        reconnecting
      },
      error: offlineMessage
    });
  };

  const startYjsSync = async (): Promise<boolean> => {
    // 每次（重）连接都是一次独立的 sync.connect 观测；上一次已结算的不受影响。
    syncStartedAt = telemetryNow();
    syncSettled = false;
    // 新连接会新建本地 doc：旧投影（含旧 epoch 的复用结果）不能再被当作当前文档。
    canonicalDocVersion += 1;
    canonicalProjection.invalidate();
    const factory = globalThis.indexedDB;
    const cache = factory ? new IndexedDbYjsCacheRepository({ indexedDb: factory, open: () => database.open() }) : null;
    // 每次同步在启动时求值一次命名空间，保证本轮 load 与后续 append/saveMetadata 用同一 key
    // （change: 2026-10-13-...，任务 5.8）；身份异步解析完成后重连/切换画布会用到新命名空间。
    const cacheId = options.cacheNamespace ? `${options.cacheNamespace() ?? "anonymous"}::${canvasId}` : canvasId;
    const cached = cache ? await cache.load(cacheId).catch(() => null) : null;

    const lifecycle = new CommandLifecycleRegistry({
      derivedRevision: () => projection.canonicalCanvas?.revision ?? 0,
      onChange: event => {
        if (event.state === "committed") settleSave(event.commandId, "success");
        else if (event.state === "rejected") settleSave(event.commandId, "failure", "command-rejected");
      }
    });

    // 只读本地 Y.Doc：先应用 published cache，再以该 state vector 连接服务端（design D10）。
    //
    // cache 校验失败（format/seq/损坏）时清空并同样从服务端全量重建。
    let cacheSeq = 0;
    let cacheWriteQueue = Promise.resolve();
    let usableCache = cached;
    const localDoc = new Y.Doc();
    if (cached && cache) {
      const validation = validateYjsCache(cached, {
        formatVersion: YJS_CANVAS_FORMAT_VERSION,
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        // 本地无法在连接前得知服务端 room epoch（握手时才拿到），因此这里只能做 format 校验；
        // epoch 不一致在 provider 回报 roomEpoch 后处理（见下方 onChange 的 staleCache 判定）。
        roomEpoch: null
      });
      if (validation.ok) {
        try {
          applyYjsCacheToDoc(localDoc, validation.load, (doc, update) => Y.applyUpdate(doc, update));
          cacheSeq = cached.updates.reduce((max, entry) => Math.max(max, entry.seq), 0);
        } catch {
          // 损坏 cache：清空并从服务端全量重建（design D10）。
          await cache.clear(cacheId).catch(() => undefined);
          cacheSeq = 0;
          usableCache = null;
        }
      } else {
        await cache.clear(cacheId).catch(() => undefined);
        usableCache = null;
      }
    }

    const provider = new ReadonlyCanvasProvider({
      socket: remote.openCanvasSession(canvasId, usableCache?.metadata.roomEpoch ?? null),
      doc: localDoc,
      canvasId,
      // socket 属于 page-owned Canvas Session transport；provider 只解绑监听。
      ownsSocket: false,
      cacheFormatVersion: usableCache?.metadata.formatVersion ?? null,
      cacheRoomEpoch: usableCache?.metadata.roomEpoch ?? null,
      onCachedDocumentDiscarded: () => {
        cacheSeq = 0;
        // 本地 doc 被替换：任何复用过的投影都不再对应当前文档。
        canonicalDocVersion += 1;
        canonicalProjection.invalidate();
        if (!cache) return;
        // 必须让 clear 先于本轮收到的任何 update 写入，避免再次读到本地多余结构。
        cacheWriteQueue = cacheWriteQueue
          .then(() => cache.clear(cacheId))
          .catch(() => undefined);
      },
      onCommandResult: (result) => {
        lifecycle.applyResult({
          commandId: result.commandId,
          status: result.status,
          revision: result.revision,
          error: result.error
        });
        // result 驱动 working projection 结算（accepted 保留效果直到 canonical 覆盖；
        // rejected/failed 立即移除并重放后续批次）。
        projection.applyResult({
          commandId: result.commandId,
          status: result.status,
          ...(result.revision !== undefined ? { revision: result.revision } : {}),
          ...(result.code !== undefined ? { code: result.code } : {}),
          ...(result.error !== undefined ? { error: result.error } : {})
        });
        woohaa3CanvasStore.getState().applyWorkingCanvas(projection.workingCanvas);
        publish({
          remote: {
            ...status.remote,
            pendingCount: projection.pendingBatches.length
          }
        });
      },
      onServerUpdate: (update) => {
        // 服务端 update 已应用进本地 doc：即使 revision 未变，内容也可能变化，必须让投影失效。
        canonicalDocVersion += 1;
        // 只缓存服务端 published update；working/pending 永不落盘（design D10）。
        cacheSeq += 1;
        const seq = cacheSeq;
        if (!cache) return;
        cacheWriteQueue = cacheWriteQueue.then(async () => {
          await cache.appendUpdate({ canvasId: cacheId, seq, update, createdAt: new Date().toISOString() });
          const revision = deriveCanvas()?.revision ?? 0;
          await cache.saveMetadata({
            canvasId: cacheId,
            formatVersion: YJS_CANVAS_FORMAT_VERSION,
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            roomEpoch: provider.providerState.roomEpoch,
            revision,
            updatedAt: new Date().toISOString()
          });
        }).catch(() => undefined);
      },
      onChange: (state) => applyYjsProviderState(state, lifecycle)
    });
    yjsProvider = provider;
    yjsLifecycle = lifecycle;

    if (typeof globalThis.addEventListener === "function") {
      if (offlineListener) globalThis.removeEventListener("offline", offlineListener);
      if (onlineListener) globalThis.removeEventListener("online", onlineListener);
      const onOffline = () => publishOffline();
      // 浏览器恢复联网不是「用户点重连」，但同样是重建连接：与显式重连共用等待与置灰逻辑，
      // 且重建失败时不再产生未处理的 promise rejection。
      const onOnline = () => {
        void rebuildConnection(async () => {
          yjsProvider?.dispose();
          yjsProvider = undefined;
          yjsLifecycle = undefined;
          await startYjsSync();
        });
      };
      offlineListener = onOffline;
      onlineListener = onOnline;
      globalThis.addEventListener("offline", onOffline);
      globalThis.addEventListener("online", onOnline);
    }

    provider.start();
    // 不在此处把本地缓存派生发布到 UI：等 provider 收到服务端权威握手（ready）后再发布，
    // 避免 WS 拒绝/权限未知时用旧缓存冒充当前身份内容（任务 5.8）。
    return true;
  };

  const attach = async (): Promise<boolean> => {
    detach();
    try { await startYjsSync(); }
    catch (error) {
      settleSync("failure", "session-attach-failed");
      settleOpen("failure", "session-attach-failed");
      throw error;
    }
    if (disposed) return false;
    publish({
      phase: "ready",
      error: isBrowserOffline() ? "网络已断开，画布只读" : null
    });
    return true;
  };

  /**
   * 执行一次连接重建，并等待 provider 结算（ready/error）或超时
   * （change: 2026-10-21-recover-canvas-connection-explicitly）。
   *
   * 重建期间发布 `reconnecting`（按钮置灰）；超时只清标记并保留只读，不谎称已连接。
   * 已同步时 transport 的重建在已 open 下是空操作，不再等相位变化，避免误报超时。
   */
  const rebuildConnection = async (rebuild: () => void | Promise<unknown>): Promise<void> => {
    const startSeq = providerPhaseSeq;
    const settledAlready = status.remote.mode === "remote" && yjsProvider?.providerState.phase === "ready";
    // 清掉旧的错误文案：重建本身就是一次恢复动作，失败会重新写入。
    setReconnecting(true, null);
    let failed = false;
    try {
      await rebuild();
    } catch {
      // 重建失败落到下方统一处理：给明确文案，不谎称已连接（也不重复计 sync.connect）。
      failed = true;
    }
    if (settledAlready) {
      setReconnecting(false);
      return;
    }
    const result = failed ? "error" : await waitForProviderSettled(startSeq);
    if (result === "timeout") {
      setReconnecting(false, "重新连接超时，画布仍为只读");
      return;
    }
    if (failed) {
      setReconnecting(false, "重新连接失败，请稍后重试");
      return;
    }
    // ready：相位与错误已由 applyYjsProviderState 发布；error：保留 provider 的错误文案。
    setReconnecting(false);
  };

  /**
   * 显式重连入口：已有 provider 时只重建物理连接（不重开画布、不回启动态）；
   * 尚未建立过连接时回落为一次完整 attach。
   */
  const reconnectNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (reconnectInFlight) return reconnectInFlight;
    const task = yjsProvider
      ? rebuildConnection(() => remote.reconnectCanvasSession())
      : rebuildConnection(() => attach());
    reconnectInFlight = task.finally(() => {
      reconnectInFlight = null;
    });
    return reconnectInFlight;
  };

  await attach();
  const session: CanvasSession = {
    getStatus: () => status,
    subscribe: (listener) => {
      listener(status);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: async () => {
      publish({ phase: "loading", error: null, remote: { ...IDLE_REMOTE, readOnly, readOnlyReason } });
      await attach();
    },
    reconnect: reconnectNow,
    requestHydrate: () => {
      // 新的渲染器每次 ready 都会收到完整快照；这里只更新状态位。
      publish({ hydrated: woohaa3CanvasStore.getState().canvas !== null });
    },
    commandLifecycle: () => yjsLifecycle ?? null,
    submitCommands: (commands: readonly CanvasCommand[], commandId: string) => {
      const submitStartedAt = telemetryNow();
      // 权限只读是**权威**结论（服务端判定），不是等第一次写入被拒：在本地就拒绝，
      // 不留 pending、不发 wire，界面拿到的 reason 能直接解释原因。
      if (readOnly) {
        return { ok: false, reason: readOnlyReason ?? "只读画布，修改不会被保存", code: "read-only" };
      }
      // 宿主重连中：明确拒绝（可重试），不登记 pending、不发 wire——不静默吞掉也不积压。
      if (options.blocksSubmissions?.()) {
        return { ok: false, reason: "本机服务正在重新连接，请稍后重试", code: HOST_RECONNECTING_SUBMIT_CODE };
      }
      if (!yjsProvider) {
        // 未连接属于门禁条件（离线只读时每次按键都会走到这里），不作为编辑失败观测，避免噪声。
        return { ok: false, reason: "画布尚未连接到 Canvas Service", code: "not-connected" };
      }
      const revision = deriveCanvas()?.revision ?? 0;
      // 1) 本地 reducer 校验 + 登记 pending（失败不发送）。
      const appended = projection.appendBatch({
        commandId,
        commands,
        baseRevision: revision,
        submittedAt: new Date().toISOString()
      });
      if (!appended.ok) {
        // 本地校验拒绝：只记稳定拒绝码（不是文案），复盘时可按 code 聚合。
        recordTelemetry({
          name: "local.validation",
          result: "rejected",
          origin: "browser",
          surface: "local-validation",
          errorCode: stableTelemetryErrorCode(appended.code, "invalid")
        });
        return { ok: false, reason: appended.message, code: appended.code };
      }
      // 2) 登记 lifecycle（复用调用方 commandId，保证与 wire 一致）。
      const handle = yjsLifecycle!.begin(revision, commandId);
      saveStarts.set(commandId, submitStartedAt);
      // 3) 发送 wire。
      const sent = yjsProvider.submitCommand({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId,
        baseRevision: revision,
        actorId: "web-canvas",
        commands: [...commands]
      });
      if (!sent.ok) {
        settleSave(commandId, "failure", "send-failed");
        // 发送失败：立即移除 pending、重放剩余批次，返回结构化失败。
        projection.rejectBatch(commandId, sent.reason);
        woohaa3CanvasStore.getState().applyWorkingCanvas(projection.workingCanvas);
        recordTelemetry({
          name: "canvas.edit",
          result: "failure",
          origin: "browser",
          surface: "editor",
          durationMs: elapsedMs(submitStartedAt),
          errorCode: "send-failed"
        });
        return { ok: false, reason: sent.reason, code: "send-failed" };
      }
      woohaa3CanvasStore.getState().applyWorkingCanvas(projection.workingCanvas);
      publish({ remote: { ...status.remote, pendingCount: projection.pendingBatches.length } });
      // 已交给 wire（本地接受）：这是编辑路径可观测的成功终态；服务端确认另有 lifecycle 事实。
      recordTelemetry({
        name: "canvas.edit",
        result: "success",
        origin: "browser",
        surface: "editor",
        durationMs: elapsedMs(submitStartedAt)
      });
      return { ok: true, handle };
    },
    isWritable: () => yjsProvider?.providerState.phase === "ready" && !isBrowserOffline() && !readOnly,
    shutdown: () => {
      // 未完成的打开/首次同步按取消计（不伪装成失败或成功）。
      settleSync("cancelled");
      settleOpen("cancelled");
      disposed = true;
      detach();
      listeners.clear();
      void database.close();
    }
  };
  return session;
}
