/**
 * Store 作为 Y.Doc 观察者 facade（任务 6.4 / 6.5 / design D9）。
 *
 * 本模块提供**从 Y.Doc 派生 ServerCanvas** 的单一入口，以及「持久化 action → 异步命令」
 * 的生命周期管理。它刻意**不**直接依赖 `yjs`：调用方注入观察注册与导出函数，
 * 因此 canvas-state 保持中立，而行为可在无 Yjs 环境下被完整测试。
 *
 * 关键不变式（spec canvas-sync）：
 * - Store 的 canvas 是 published Y.Doc 的**派生结果**，不是本地权威；
 * - 所有持久化 action 返回**异步 command handle**，只有 accepted + derived revision
 *   达到 result revision 时才算 committed；
 * - selection / 拖拽 preview / 表单 draft 属于本地瞬时状态，不进入这里的命令路径。
 */

/** 命令生命周期状态（design D9；observed 由 working projection 的 effect satisfaction 驱动）。 */
export type CommandLifecycle =
  | "pending"
  | "accepted"
  | "observed"
  | "rejected"
  | "committed";

export type CommandHandle = {
  commandId: string;
  /** 当前生命周期。 */
  state: CommandLifecycle;
  /** 提交时客户端看到的 revision（用于判断 derived 是否已覆盖）。 */
  baseRevision: number;
  /** 服务端接受的 revision；未 accepted 前为 null。 */
  resultRevision: number | null;
  /** 失败原因（rejected / 后续失败）。 */
  error: string | null;
  /** 等待 committed（accepted 且 derived revision >= result revision）。 */
  settled: Promise<CommandHandle>;
};

export type CommandLifecycleEvent = {
  commandId: string;
  state: CommandLifecycle;
  resultRevision: number | null;
  error: string | null;
};

export type CommandLifecycleRegistryOptions = {
  /** 当前派生的业务 revision（来自 Y.Doc）。 */
  derivedRevision: () => number;
  /** 生命周期变化回调（宿主据此刷新 UI）。 */
  onChange?: (event: CommandLifecycleEvent) => void;
  /** 生成 commandId。 */
  generateCommandId?: () => string;
};

type MutableHandle = CommandHandle & {
  resolveSettled: (handle: CommandHandle) => void;
};

/**
 * 命令生命周期注册表。
 *
 * 覆盖 design D9 的两种到达顺序：
 * - **result 先到**：accepted 后等 derived revision 追上；
 * - **update 先到**：update 到达时 derived revision 已前进，accepted 一到即可 committed。
 *
 * 这正是「客户端必须同时等待 accepted 与本地 derived revision」的可执行形式。
 */
export class CommandLifecycleRegistry {
  private readonly handles = new Map<string, MutableHandle>();
  private readonly derivedRevision: () => number;
  private readonly onChange: ((event: CommandLifecycleEvent) => void) | undefined;
  private readonly generateCommandId: () => string;

  constructor(options: CommandLifecycleRegistryOptions) {
    this.derivedRevision = options.derivedRevision;
    this.onChange = options.onChange;
    this.generateCommandId = options.generateCommandId ?? (() => crypto.randomUUID());
  }

  /** 开启一个待提交命令。传入 commandId 时复用它（wire 必须与登记一致）。 */
  begin(baseRevision: number, commandId?: string): CommandHandle {
    const id = commandId ?? this.generateCommandId();
    let resolveSettled!: (handle: CommandHandle) => void;
    const settled = new Promise<CommandHandle>((resolve) => {
      resolveSettled = resolve;
    });
    const handle: MutableHandle = {
      commandId: id,
      state: "pending",
      baseRevision,
      resultRevision: null,
      error: null,
      settled,
      resolveSettled
    };
    this.handles.set(id, handle);
    this.emit(handle);
    return handle;
  }

  /**
   * 标记命令的 working effect 已被 canonical 观察到（change:
   * add-frontend-speculative-canvas-state，design D6）。update-first 场景下由 working
   * projection 的 effect satisfaction 触发。
   */
  observe(commandId: string): void {
    const handle = this.handles.get(commandId);
    if (!handle || handle.state !== "pending") return;
    handle.state = "observed";
    this.emit(handle);
  }

  /** 收到服务端 COMMAND_RESULT。 */
  applyResult(input: {
    commandId: string;
    status: "accepted" | "duplicate" | "rejected" | "failed";
    revision?: number;
    error?: string;
  }): void {
    const handle = this.handles.get(input.commandId);
    if (!handle) return;

    if (input.status === "rejected" || input.status === "failed") {
      handle.state = "rejected";
      handle.error = input.error ?? "命令被拒绝";
      this.emit(handle);
      handle.resolveSettled(handle);
      return;
    }

    // accepted/duplicate：若已被 working projection 观察到则保留 observed，否则 accepted。
    if (handle.state !== "observed") handle.state = "accepted";
    handle.resultRevision = input.revision ?? handle.baseRevision;
    handle.error = null;
    this.emit(handle);
    this.maybeCommit(handle);
  }

  /**
   * 本地派生的 revision 前进后调用（Y.Doc observer 触发）。
   *
   * 若已有 accepted/observed 且 derived 已覆盖 result revision，则标记 committed。
   */
  onDerivedRevisionChanged(): void {
    for (const handle of this.handles.values()) {
      if (handle.state === "accepted" || handle.state === "observed") this.maybeCommit(handle);
    }
  }

  /** 查询某命令当前 handle（测试用）。 */
  get(commandId: string): CommandHandle | undefined {
    return this.handles.get(commandId);
  }

  get pendingCount(): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.state === "pending" || handle.state === "accepted") count += 1;
    }
    return count;
  }

  /** 清理已 committed/rejected 的记录（避免无界增长）。 */
  prune(): void {
    for (const [commandId, handle] of this.handles) {
      if (handle.state === "committed" || handle.state === "rejected") {
        this.handles.delete(commandId);
      }
    }
  }

  private maybeCommit(handle: MutableHandle): void {
    if ((handle.state !== "accepted" && handle.state !== "observed") || handle.resultRevision === null) return;
    // 关键：accepted 只说明服务端已持久化；本页还必须等**派生文档**达到该 revision，
    // 否则 UI 会短暂显示一个本地尚未应用的「已提交」状态。
    if (this.derivedRevision() < handle.resultRevision) return;
    handle.state = "committed";
    this.emit(handle);
    handle.resolveSettled(handle);
  }

  private emit(handle: MutableHandle): void {
    this.onChange?.({
      commandId: handle.commandId,
      state: handle.state,
      resultRevision: handle.resultRevision,
      error: handle.error
    });
  }
}

/**
 * 本地瞬时状态容器（任务 6.7 / design D9）。
 *
 * selection、拖拽 preview、表单 draft 都放这里：它们**不**推进 revision、不进入 Yjs cache，
 * 也不产生命令。单独建模是为了让「哪些状态是规范的」在类型层面就清楚。
 */
export type TransientCanvasState = {
  /** 画布选中节点；`null` 表示无选中。 */
  selectedNodeId: string | null;
  /** 拖拽中的临时位置（nodeId -> 逻辑坐标）。 */
  dragPreview: Record<string, { x: number; y: number }>;
  /** 尚未提交的表单草稿（按 nodeId 隔离）。 */
  drafts: Record<string, Record<string, unknown>>;
};

export function createTransientCanvasState(): TransientCanvasState {
  return { selectedNodeId: null, dragPreview: {}, drafts: {} };
}

/**
 * 判定一次 store 变更是否**只能**走本地瞬时路径（不应产生命令）。
 *
 * 用于静态检查与测试：这些字段永不进入 Y.Doc。
 */
export const TRANSIENT_ONLY_FIELDS = ["selectedNodeId", "dragPreview", "drafts"] as const;
