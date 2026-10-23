/**
 * 多文档工作区注册表（纯逻辑，无 DOM）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2/1.4 / design D1/D2/D8）。
 *
 * 编辑器不拥有画布节点或宿主服务；这里只维护**有序文档条目**、当前活动项、每文档代际与
 * 活动操作门禁。控制器/内核文档、保存 attempt、文件字节等资源由宿主适配层按 `id` 持有；
 * 本模块只保证：
 * - 节点身份 `(canvasId, nodeId)` 复用一个条目，复制节点与同名文件各自独立；
 * - 关闭后重新打开同一节点得到新的 `generation`，旧回调据此被拒绝；
 * - 达到上限时拒绝新打开，已有条目仍可激活；
 * - 关闭活动项优先激活左邻项，其次右邻项，最后一项关闭后没有活动项。
 *
 * 状态不可变快照 + 订阅，供 React 以 `useSyncExternalStore` 消费。
 */

/** 工作区最多同时打开的文档数（运行政策，不写入工程格式）。 */
export const MAX_OPEN_DOCUMENTS = 8;

/** 文档来源：画布节点或用户显式打开的独立文件。 */
export type EditorDocumentSource =
  | { kind: "node"; canvasId: string; nodeId: string }
  | { kind: "file"; fileName: string };

/**
 * 文档状态（展示用）。
 *
 * `unavailable`：节点被删除/权限丢失或工程不可编辑，内容仍可本地导出；
 * `conflict`：权威内容已改变而本地有净变化，禁止覆盖。
 */
export type EditorDocumentStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "history-pending"
  | "conflict"
  | "unavailable"
  | "error";

export type EditorDocumentEntry = {
  /** 不透明文档 id；节点文档由节点身份派生，文件文档每次打开新建。 */
  id: string;
  source: EditorDocumentSource;
  /** 展示名称（节点标题或文件名）。 */
  name: string;
  /** 同名项的来源补充信息（节点 id / 文件序号）；无法区分时为 null。 */
  detail: string | null;
  status: EditorDocumentStatus;
  /** 失败/冲突原因（`status` 为 clean/dirty 时通常为 null）。 */
  message: string | null;
  /** 能否写回目的地（只读画布或失效节点为 false）。 */
  writable: boolean;
  /** 文档代际：重新打开同一节点会递增，旧异步结果不得发布。 */
  generation: number;
};

export type EditorDocumentWorkspaceSnapshot = {
  entries: readonly EditorDocumentEntry[];
  activeId: string | null;
  /** 当前文档未结束操作的原因（笔迹/未确认草稿）；非空时拒绝切换。 */
  activeGate: string | null;
};

export type OpenDocumentInput =
  | { kind: "node"; canvasId: string; nodeId: string; name: string; writable?: boolean; detail?: string | null }
  | { kind: "file"; fileName: string; name?: string; detail?: string | null };

export type OpenDocumentResult =
  | { ok: true; id: string; created: boolean; generation: number }
  | { ok: false; code: "limit" | "invalid"; reason: string };

export type ActivateDocumentResult =
  | { ok: true; changed: boolean; id: string }
  | { ok: false; code: "missing" | "gate"; reason: string };

export type CloseDocumentResult =
  | { ok: true; nextActiveId: string | null }
  | { ok: false; code: "missing"; reason: string };

/** 默认状态：新条目干净、可写。 */
function defaultEntry(id: string, source: EditorDocumentSource, name: string, detail: string | null, generation: number, writable: boolean): EditorDocumentEntry {
  return { id, source, name, detail, status: "clean", message: null, writable, generation };
}

/** 节点文档 id：同一 `(canvasId,nodeId)` 稳定复用；复制节点有不同 id。 */
export function nodeDocumentId(canvasId: string, nodeId: string): string {
  return `node:${canvasId}:${nodeId}`;
}

/**
 * 文档注册表。
 *
 * 只保存轻量条目；`resource`（控制器、字节、取景）由调用方按 `id` 自持。所有会改变
 * 活动项或条目集合的操作都先校验门禁，再一次性发布新快照。
 */
export class EditorDocumentRegistry {
  private entries: EditorDocumentEntry[] = [];
  private active: string | null = null;
  private gate: { id: string; reason: string } | null = null;
  private fileSequence = 0;
  /**
   * 每个节点身份的累计代际：关闭重开后继续递增，旧回调据此被拒绝。
   * 文件来源每次打开都是新条目，无需记录。
   */
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private snapshot: EditorDocumentWorkspaceSnapshot = { entries: [], activeId: null, activeGate: null };

  constructor(private readonly limit: number = MAX_OPEN_DOCUMENTS) {}

  snapshotState = (): EditorDocumentWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 当前条目（副本）。 */
  entry(id: string): EditorDocumentEntry | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /**
   * 节点对应的已打开条目。
   *
   * 按来源匹配而不是按派生 id：独立文件“添加到画布”会在**保留原条目 id** 的前提下改为
   * 绑定节点，此时派生 id 与该条目不同（change: 2026-10-21，design D5）。
   */
  findByNode(canvasId: string, nodeId: string): EditorDocumentEntry | null {
    return this.entries.find((entry) => entry.source.kind === "node"
      && entry.source.canvasId === canvasId && entry.source.nodeId === nodeId) ?? null;
  }

  activeId(): string | null {
    return this.active;
  }

  /**
   * 打开或复用文档。
   *
   * 节点来源按 `(canvasId,nodeId)` 去重，复用时不递增代际；文件来源每次调用产生新条目
   * （同名文件也各自独立）。达到上限时拒绝，既有条目不受影响。
   */
  open(input: OpenDocumentInput): OpenDocumentResult {
    if (input.kind === "node") {
      if (!input.canvasId || !input.nodeId) return { ok: false, code: "invalid", reason: "缺少节点身份" };
      const existing = this.findByNode(input.canvasId, input.nodeId);
      const id = existing?.id ?? nodeDocumentId(input.canvasId, input.nodeId);
      if (existing) {
        const updated: EditorDocumentEntry = {
          ...existing,
          name: input.name,
          writable: input.writable ?? existing.writable
        };
        this.replace(updated);
        this.active = id;
        this.publish();
        return { ok: true, id, created: false, generation: existing.generation };
      }
      if (!this.hasCapacity()) return this.limitFailure();
      const generation = this.nextGeneration(id);
      const entry = defaultEntry(id, { kind: "node", canvasId: input.canvasId, nodeId: input.nodeId },
        input.name, input.detail ?? input.nodeId, generation, input.writable ?? true);
      this.append(entry);
      return { ok: true, id, created: true, generation: entry.generation };
    }

    const fileName = input.fileName.trim();
    if (!fileName) return { ok: false, code: "invalid", reason: "缺少文件名" };
    if (!this.hasCapacity()) return this.limitFailure();
    const sequence = ++this.fileSequence;
    const id = `file:${sequence}:${Date.now().toString(36)}`;
    const entry = defaultEntry(id, { kind: "file", fileName },
      input.name ?? fileName, input.detail ?? `文件 ${sequence}`, 1, true);
    this.append(entry);
    return { ok: true, id, created: true, generation: entry.generation };
  }

  /** 激活文档；门禁存在时拒绝切换（重复激活同一项为无操作）。 */
  activate(id: string): ActivateDocumentResult {
    if (!this.entry(id)) return { ok: false, code: "missing", reason: "文档已关闭" };
    if (id === this.active) return { ok: true, changed: false, id };
    if (this.gate) return { ok: false, code: "gate", reason: this.gate.reason };
    this.active = id;
    this.publish();
    return { ok: true, changed: true, id };
  }

  /** 按拖放目标重排文档；活动项和资源身份保持不变。 */
  reorder(id: string, targetId: string): boolean {
    const from = this.entries.findIndex((entry) => entry.id === id);
    const target = this.entries.findIndex((entry) => entry.id === targetId);
    if (from < 0 || target < 0 || from === target) return false;
    const moving = this.entries[from]!;
    const next = this.entries.filter((entry) => entry.id !== id);
    next.splice(target, 0, moving);
    this.entries = next;
    this.publish();
    return true;
  }

  /** 关闭条目；活动项关闭后优先左邻、其次右邻，最后一项关闭后无活动项。 */
  close(id: string): CloseDocumentResult {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return { ok: false, code: "missing", reason: "文档已关闭" };
    const wasActive = this.active === id;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.gate?.id === id) this.gate = null;
    if (wasActive) {
      const neighbour = this.entries[index - 1] ?? this.entries[index] ?? null;
      this.active = neighbour?.id ?? null;
    }
    this.publish();
    return { ok: true, nextActiveId: this.active };
  }

  /**
   * 更新条目（状态、名称、可写性）。不存在时忽略（迟到结果不得复活已关闭项）。
   */
  update(id: string, patch: Partial<Omit<EditorDocumentEntry, "id" | "source" | "generation">>): boolean {
    const entry = this.entry(id);
    if (!entry) return false;
    this.replace({ ...entry, ...patch });
    this.publish();
    return true;
  }

  /**
   * 递增代际：重新打开/重建内容后，旧回调按旧代际被拒绝。
   */
  bumpGeneration(id: string): number | null {
    const entry = this.entry(id);
    if (!entry) return null;
    const next = { ...entry, generation: entry.generation + 1 };
    this.replace(next);
    this.publish();
    return next.generation;
  }

  /** 代际是否仍有效（已关闭或已重建返回 false）。 */
  isCurrent(id: string, generation: number): boolean {
    const entry = this.entry(id);
    return entry !== null && entry.generation === generation;
  }

  /**
   * 独立文件成功发布为节点后原位绑定：保留 id/顺序/代际，来源改为节点。
   *
   * 目标节点已被另一个条目打开时不合并（返回 null 由调用方决定）；同一 id 重入为幂等。
   */
  rebindToNode(id: string, input: { canvasId: string; nodeId: string; name?: string }): EditorDocumentEntry | null {
    const entry = this.entry(id);
    if (!entry) return null;
    const targetId = nodeDocumentId(input.canvasId, input.nodeId);
    const existing = this.entry(targetId);
    if (existing && existing.id !== id) {
      // 已有另一条目打开同一节点：关掉旧的（它的资源由调用方释放），保留当前条目的顺序。
      this.entries = this.entries.filter((candidate) => candidate.id !== targetId);
      if (this.active === targetId) this.active = id;
    }
    const rebound: EditorDocumentEntry = {
      ...entry,
      id,
      source: { kind: "node", canvasId: input.canvasId, nodeId: input.nodeId },
      name: input.name ?? entry.name,
      detail: input.nodeId,
      writable: true,
      status: entry.status === "unavailable" ? "clean" : entry.status
    };
    this.replace(rebound);
    this.publish();
    return rebound;
  }

  /** 记录/清除当前文档未结束操作的原因（拒绝切换的依据）。 */
  setGate(id: string, reason: string | null): void {
    if (reason === null) {
      if (this.gate?.id !== id) return;
      this.gate = null;
      this.publish();
      return;
    }
    // 同一条原因不重复发布：状态回调可能在同一轮里多次报告相同门禁。
    if (this.gate?.id === id && this.gate.reason === reason) return;
    this.gate = { id, reason };
    this.publish();
  }

  /** 当前门禁（仅在门禁属于该文档时返回原因）。 */
  gateReason(id: string): string | null {
    return this.gate?.id === id ? this.gate.reason : null;
  }

  /** 是否有条目处于未结算状态（保存中/未保存/冲突/保存失败）。 */
  unsettled(): EditorDocumentEntry[] {
    return this.entries.filter((entry) => entry.status === "dirty" || entry.status === "saving"
      || entry.status === "conflict" || entry.status === "error" || entry.status === "history-pending");
  }

  /** 页面释放：清空全部条目与门禁（不发布活动项）。 */
  clear(): void {
    this.entries = [];
    this.active = null;
    this.gate = null;
    this.publish();
  }

  private hasCapacity(): boolean {
    return this.entries.length < this.limit;
  }

  /** 节点身份的下一个代际：关闭后重开继续递增，使旧异步结果失效。 */
  private nextGeneration(id: string): number {
    const next = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, next);
    return next;
  }

  private limitFailure(): OpenDocumentResult {
    return {
      ok: false,
      code: "limit",
      reason: `最多同时打开 ${this.limit} 个文档，请先关闭一个后再试`
    };
  }

  private append(entry: EditorDocumentEntry): void {
    this.entries = [...this.entries, entry];
    this.active = entry.id;
    this.publish();
  }

  private replace(entry: EditorDocumentEntry): void {
    this.entries = this.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate));
  }

  private publish(): void {
    this.snapshot = {
      entries: this.entries.map((entry) => ({ ...entry })),
      activeId: this.active,
      activeGate: this.gate ? this.gate.reason : null
    };
    for (const listener of this.listeners) listener();
  }
}

/**
 * 关闭活动文档后的邻项：优先左侧相邻项，没有左侧才用右侧。
 * 已由 `close()` 实现；本函数供调用方在不改变注册表时预览结果（测试/文档用）。
 */
export function neighbourAfterClose(entries: readonly EditorDocumentEntry[], closingId: string): string | null {
  const index = entries.findIndex((entry) => entry.id === closingId);
  if (index < 0) return null;
  const remaining = entries.filter((entry) => entry.id !== closingId);
  return (remaining[index - 1] ?? remaining[index] ?? null)?.id ?? null;
}

/** 节点来源的 `(canvasId,nodeId)`；文件来源返回 null。 */
export function nodeIdentityOf(entry: EditorDocumentEntry): { canvasId: string; nodeId: string } | null {
  return entry.source.kind === "node" ? { canvasId: entry.source.canvasId, nodeId: entry.source.nodeId } : null;
}
