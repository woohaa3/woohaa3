/**
 * 页面级资源需求与预算 owner
 * （change: 2026-10-23-scale-canvas-media-residency，design D1/D2/D3/D8）。
 *
 * `CanvasResourceCoordinator` 只维护**可丢弃**状态：当前需求集合、各通道准入队列、pin/lease
 * 与诊断计数。它不写 Y.Doc、不持有媒体像素、不决定呈现；实际资源成本与可用性由 Bevy/native
 * adapter 与各媒体 owner 反馈。
 *
 * 职责边界：
 * - 需求投影：从 canonical/working 内容身份、已接受视口与 surface 计算 interactive/visible/
 *   prefetch/warm 集合；无有效 surface 时暂停普通预热，但保留显式 pin。
 * - 准入：所有重资源入口先 `admit` 再创建；`release` 之后才归还名额。
 * - 预算：图片解码、视频会话、首帧取帧、模型准备、上传 staging 与预览槽共用同一页策略。
 * - 失效：删除、切画布、失权与 runtime 代际变化撤销对应需求，不复活旧代资源。
 */
import {
  byteBudget,
  concurrencyLimit,
  resolveResidencyPolicy,
  selectThumbnailTier,
  type ResidencyChannel,
  type ResidencyPolicy,
  type ResidencyPurpose,
  type ThumbnailTier
} from "./policy.js";
import {
  ResidencyChannelQueue,
  type ResidencyLease,
  type ResidencyOutcome,
  type ResidencySnapshot
} from "./channel-queue.js";

/** 一个节点在某一帧的资源需求。 */
export type NodeResidencyDemand = {
  nodeId: string;
  purpose: ResidencyPurpose;
  /** 屏幕物理长边（CSS 像素 × DPR），用于选缩略图档。 */
  physicalEdge: number;
  /** 稳定内容身份（storageKey/URL/content identity）；不参与节点展示身份。 */
  contentKey: string;
  /** 需求是否仍然有效；失效由 coordinator 在下一帧移除。 */
  live: boolean;
};

export type ResidencyViewport = { x: number; y: number; zoom: number };
export type ResidencySurface = { width: number; height: number; pixelRatio: number };

/** 需求投影输入：由 canvas-shell 的唯一帧结算点提供。 */
export type ResidencyProjectionInput = {
  /** 当前接受的视口（世界坐标）；缺省视为无有效 surface。 */
  viewport: ResidencyViewport | null;
  /** 画布表面尺寸（CSS px + DPR）；缺省或非正视为无有效 surface。 */
  surface: ResidencySurface | null;
  /** 页面是否可见；隐藏时暂停普通新预热。 */
  pageVisible: boolean;
  /** 当前交互/聚焦/播放/捕获目标节点（interactive）。 */
  interactive: readonly string[];
  /** 显式 pin（严格输出/聚焦过渡）；不因无 surface 或离屏被淘汰。 */
  pins: readonly string[];
  /** 文档中带媒体/模型的节点（nodeId → 内容身份 + 世界包围盒长边）。 */
  candidates: readonly {
    nodeId: string;
    contentKey: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** 是否属于可被准入的媒体类型（图片/视频/模型/片场平面）。 */
    eligible: boolean;
    /**
     * 是否消耗离屏预览渲染槽（模型/复合资产）。
     *
     * 缺省视为 `false`：只有明确需要离屏预览相机的需求才占槽。`collectResidencyCandidates`
     * 总是显式给出该值（模型/复合资产 true，图片/视频 false）。
     */
    previewSlot?: boolean;
  }[];
};

export type ResidencyDiagnostics = {
  policy: ResidencyPolicy;
  surfaceValid: boolean;
  pageVisible: boolean;
  demands: number;
  byPurpose: Record<ResidencyPurpose, number>;
  channels: ResidencySnapshot[];
  /** 当前驻留的节点 → 档位（只读快照）。 */
  resident: number;
  /** GPU 估算合计（字节；估算，不是驱动实测显存）。 */
  estimatedGpuBytes: number;
  /** CPU 派生估算合计（字节）。 */
  estimatedCpuBytes: number;
  /** 因预算或 surface 被拒绝/延后的需求数（累计）。 */
  deferred: number;
  /** 因失效撤销的需求数（累计）。 */
  revoked: number;
  /** 本帧上传 staging 已用/预算字节（design D3；预算来自唯一页策略）。 */
  uploadStaging: { usedBytes: number; budgetBytes: number };
};

export type ResidencyAdmitRequest<T> = {
  channel: ResidencyChannel;
  /** 稳定内容身份；同 key 合并。 */
  key: string;
  purpose: ResidencyPurpose;
  /** 预计字节成本。 */
  bytes?: number;
  /** 底层工作是否可中止（不可中止的取消转 draining）。 */
  abortable?: boolean;
  run: (context: { lease: ResidencyLease }) => Promise<T>;
};

const EMPTY_PURPOSE: Record<ResidencyPurpose, number> = {
  interactive: 0,
  visible: 0,
  prefetch: 0,
  warm: 0
};

/**
 * 页级资源协调器。
 *
 * 一个 attach scope 只有一个实例；`dispose` 释放全部队列与需求，之后任何 `admit` 都立即返回
 * cancelled（不创建资源）。
 */
export class CanvasResourceCoordinator {
  private readonly policy: ResidencyPolicy;
  private readonly queues = new Map<ResidencyChannel, ResidencyChannelQueue>();
  private demands = new Map<string, NodeResidencyDemand>();
  private readonly pins = new Set<string>();
  private surfaceValid = false;
  private pageVisible = true;
  private deferred = 0;
  private revoked = 0;
  private disposed = false;
  private frameIndex = 0;
  /** 本帧上传 staging 已用字节（design D3；`beginFrame` 重置）。 */
  private uploadStagingUsed = 0;
  /** 准入集合（含档位/用途）每发生一次实质变化递增；供媒体 owner 跳过静止全量重建。 */
  private revision = 0;
  private readonly now: () => number;
  /** 节点离开需求集合的时刻（毫秒）；宽限内重新取得需求不重新解码（design D1）。 */
  private readonly offscreenSince = new Map<string, number>();

  constructor(options: { policy?: Partial<ResidencyPolicy>; now?: () => number } = {}) {
    this.policy = resolveResidencyPolicy(options.policy ?? {});
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /** 当前生效策略（只读）。 */
  getPolicy(): ResidencyPolicy {
    return this.policy;
  }

  /** 节点当前档位（无需求/未驻留返回 null）。 */
  tierOf(nodeId: string): ThumbnailTier | null {
    const demand = this.demands.get(nodeId);
    return demand ? selectThumbnailTier(demand.physicalEdge) : null;
  }

  /** 节点当前需求用途（无需求返回 null）。 */
  purposeOf(nodeId: string): ResidencyPurpose | null {
    return this.demands.get(nodeId)?.purpose ?? null;
  }

  /** 是否属于当前准入集合（未准入的节点只能用占位/合法缓存图）。 */
  isAdmitted(nodeId: string): boolean {
    return this.demands.has(nodeId);
  }

  /** 当前准入集合（只读快照，供测试与诊断）。 */
  admittedNodeIds(): string[] {
    return [...this.demands.keys()];
  }

  /**
   * 当前准入集合的稳定内容身份（去重）。
   *
   * 模型 payload lease 按**内容**提交：同一资源被多个节点引用时只需一份 payload，且 lease
   * 不随节点展示身份变化（design D4/D5）。
   */
  admittedContentKeys(): string[] {
    const keys = new Set<string>();
    for (const demand of this.demands.values()) if (demand.contentKey) keys.add(demand.contentKey);
    return [...keys];
  }

  /**
   * 按最新输入重算需求投影。
   *
   * 返回本帧新准入的节点 id：调用方据此创建媒体对象；未返回的节点不得创建重资源。
   * 无有效 surface 或页面隐藏时只保留 interactive + pins，其余需求撤销。
   */
  project(input: ResidencyProjectionInput): string[] {
    if (this.disposed) return [];
    this.frameIndex += 1;
    this.pageVisible = input.pageVisible;
    const viewport = input.viewport;
    const surface = input.surface;
    this.surfaceValid = Boolean(
      viewport && surface && surface.width > 0 && surface.height > 0 && Number.isFinite(viewport.zoom) && viewport.zoom > 0
    );
    const interactive = new Set(input.interactive);
    const pins = new Set(input.pins);
    this.pins.clear();
    for (const id of pins) this.pins.add(id);

    // 视口内（不含预热余量）与预热余量（含余量、视口外）分两级：预热必须排在真正可见之后
    // （design D1「预热首先让位」），否则平移余量会和当前可见卡片抢同一批预览槽。
    const margin = this.policy.prefetchMarginFactor;
    const insideView = this.surfaceValid && viewport && surface
      ? {
          left: -viewport.x / viewport.zoom,
          top: -viewport.y / viewport.zoom,
          right: (surface.width - viewport.x) / viewport.zoom,
          bottom: (surface.height - viewport.y) / viewport.zoom
        }
      : null;
    const view = this.surfaceValid && viewport && surface
      ? {
          left: insideView!.left - (surface.width * margin) / viewport.zoom,
          top: insideView!.top - (surface.height * margin) / viewport.zoom,
          right: insideView!.right + (surface.width * margin) / viewport.zoom,
          bottom: insideView!.bottom + (surface.height * margin) / viewport.zoom
        }
      : null;
    const zoom = this.surfaceValid && viewport ? viewport.zoom : 1;
    const pixelRatio = this.surfaceValid && surface ? Math.min(3, Math.max(1, surface.pixelRatio || 1)) : 1;

    const previous = new Set(this.demands.keys());
    const next = new Map<string, NodeResidencyDemand>();
    for (const candidate of input.candidates) {
      if (!candidate.eligible) continue;
      const purpose = this.classify(candidate, interactive, pins, view, insideView);
      if (!purpose) continue;
      const physicalEdge = Math.max(candidate.width, candidate.height) * zoom * pixelRatio;
      const existing = this.demands.get(candidate.nodeId);
      // 需求未变化时保留原对象，避免每帧重建（静止热路径）。
      if (existing && existing.purpose === purpose && existing.contentKey === candidate.contentKey
        && existing.physicalEdge === physicalEdge) {
        next.set(candidate.nodeId, existing);
        continue;
      }
      next.set(candidate.nodeId, {
        nodeId: candidate.nodeId,
        purpose,
        physicalEdge,
        contentKey: candidate.contentKey,
        live: true
      });
    }
    // 需求超过预览槽/预算时按 purpose 裁剪；interactive 与 pins 永不裁剪。
    const candidatesById = new Map(input.candidates.map((candidate) => [candidate.nodeId, candidate]));
    const admitted = this.applyBudget(next, pins, candidatesById);
    // 离屏宽限（design D1）：因视口移动而离开需求的节点在 `offscreenGraceMs` 内保留上一次
    // 合法需求，避免平移/缩放抖动反复丢弃并重解码同一批媒体；宽限结束或超出预算才真正撤销。
    // 无有效 surface、页面隐藏、内容失效都不享受宽限：那不是「暂时看不见」而是「不该驻留」。
    // 保留的是**原对象**（不重写 purpose/不新建对象），所以宽限期间的静止帧不会抬高
    // `projectionRevision()`，媒体 owner 仍走零重建路径。
    const nowMs = this.now();
    const graceEligible = this.surfaceValid && this.pageVisible;
    if (graceEligible) {
      const admittedIds = new Set(admitted.keys());
      // 只为上一帧仍驻留、这一帧变成「可见文档但不需要」的节点建立宽限计时。
      for (const nodeId of this.demands.keys()) {
        if (admittedIds.has(nodeId)) { this.offscreenSince.delete(nodeId); continue; }
        const candidate = candidatesById.get(nodeId);
        if (!candidate || !candidate.eligible) { this.offscreenSince.delete(nodeId); continue; }
        // 只有「因视口移动而暂时看不见」的需求享受宽限。交互/pin 结束是显式操作语义，
        // 必须立即生效（design D1：选中与 pin 的释放不能被宽限拖住）。
        if (this.demands.get(nodeId)?.purpose === "interactive") { this.offscreenSince.delete(nodeId); continue; }
        if (!this.offscreenSince.has(nodeId)) this.offscreenSince.set(nodeId, nowMs);
      }
      for (const nodeId of [...this.offscreenSince.keys()]) {
        if (!candidatesById.get(nodeId)?.eligible || !this.demands.has(nodeId)) this.offscreenSince.delete(nodeId);
      }
      // 宽限保留同样受页预算约束：按剩余 GPU 估算余量依次保留，超预算立即淘汰。
      let gpu = 0;
      let previewSlots = 0;
      for (const [nodeId, demand] of admitted) {
        gpu += estimateDemandBytes(demand);
        if (candidatesById.get(nodeId)?.previewSlot === true) previewSlots += 1;
      }
      const slots = Math.max(1, Math.floor(this.policy.previewSlots));
      // 最久离屏的排在最后，预算不足时先放弃它们。
      const pending = [...this.offscreenSince.entries()].sort((a, b) => b[1] - a[1]);
      for (const [nodeId, since] of pending) {
        if (nowMs - since > this.policy.offscreenGraceMs) { this.offscreenSince.delete(nodeId); continue; }
        const demand = this.demands.get(nodeId);
        if (!demand || admitted.has(nodeId)) continue;
        // 宽限同样按类别收敛：预览槽只对离屏预览需求计数，普通媒体卡不因槽满被丢弃。
        const slot = candidatesById.get(nodeId)?.previewSlot === true;
        if (slot && previewSlots >= slots) continue;
        const cost = estimateDemandBytes(demand);
        if (admitted.size > 0 && gpu + cost > this.policy.gpuDerivedBytes) break;
        gpu += cost;
        if (slot) previewSlots += 1;
        admitted.set(nodeId, demand);
      }
    } else {
      this.offscreenSince.clear();
    }
    const before = this.demands;
    this.demands = new Map(admitted);
    const fresh: string[] = [];
    for (const nodeId of admitted.keys()) if (!previous.has(nodeId)) fresh.push(nodeId);
    for (const nodeId of previous) if (!admitted.has(nodeId)) this.revoked += 1;
    if (admitted.size < next.size) this.deferred += next.size - admitted.size;
    // 变更版本覆盖「集合变化」与「档位/用途变化」：媒体 owner 据此决定是否重建绑定。
    if (this.demandSetChanged(before, admitted)) this.revision += 1;
    return fresh;
  }

  /** 准入集合是否发生了媒体 owner 必须重建绑定的变化（成员、用途或档位）。 */
  private demandSetChanged(
    before: ReadonlyMap<string, NodeResidencyDemand>,
    after: ReadonlyMap<string, NodeResidencyDemand>
  ): boolean {
    if (before.size !== after.size) return true;
    for (const [nodeId, demand] of after) if (before.get(nodeId) !== demand) return true;
    return false;
  }

  /**
   * 当前准入集合的变更版本。
   *
   * 媒体 owner 用它判断是否需要重建绑定：静止帧（版本不变）不得重新解析全量媒体 URL
   * （design D7 / 任务 7.1）。
   */
  projectionRevision(): number {
    return this.revision;
  }

  /** 撤销某节点的需求与其通道任务（删除/换源/失权）。 */
  revoke(nodeId: string): void {
    if (!this.demands.delete(nodeId)) return;
    this.revoked += 1;
    this.offscreenSince.delete(nodeId);
    for (const queue of this.queues.values()) queue.cancelKey(nodeId);
  }

  /** 撤销全部需求与在途任务（切画布/失权/dispose）。 */
  revokeAll(): void {
    if (this.demands.size) this.revoked += this.demands.size;
    this.demands.clear();
    this.pins.clear();
    this.offscreenSince.clear();
    for (const queue of this.queues.values()) queue.cancelAll();
  }

  /**
   * 先准入再创建：取得 lease 后才允许创建图片/video/模型准备。
   *
   * `admit` 不创建媒体对象；它只排队、计数并在轮到执行时调用 `run`。`run` 内部才允许
   * 创建资源，且必须 await 到真实终结（解码完成/失败/取帧结束）才返回。
   */
  admit<T>(request: ResidencyAdmitRequest<T>): Promise<ResidencyOutcome<T>> {
    if (this.disposed) return Promise.resolve({ status: "cancelled" });
    const queue = this.queueFor(request.channel);
    return queue.admit({
      key: request.key,
      purpose: request.purpose,
      bytes: request.bytes ?? 0,
      abortable: request.abortable ?? true,
      run: request.run
    });
  }

  /** 撤销某内容身份的通道任务（不撤销需求投影；用于换源）。 */
  cancel(key: string): void {
    for (const queue of this.queues.values()) queue.cancelKey(key);
  }

  /** 帧前导：重置逐帧额度（上传 staging / 预览槽）。 */
  beginFrame(): void {
    this.frameIndex += 1;
    this.uploadStagingUsed = 0;
    for (const queue of this.queues.values()) queue.beginFrame();
  }

  /**
   * 申请本帧上传 staging 额度（design D3：每帧 8 MiB，交互优先）。
   *
   * 返回 false 表示本帧额度已用尽：调用方**不得**调用上传，保留待上传状态等下一帧，
   * 也不能把「本帧没上传」记成失败。没有协调器的路径（单测/旧入口）不调用本方法。
   *
   * `interactive` 上传不受逐帧额度限制：严格取帧/截图在被冻结的帧内忙等，帧前导可能整段
   * 不执行，若也排队会让「按预算分批」退化成输出超时；交互优先本来就是 D3 的排序前提。
   */
  spendUploadBytes(bytes: number, interactive = false): boolean {
    if (!Number.isFinite(bytes) || bytes <= 0) return true;
    if (interactive) {
      this.uploadStagingUsed += bytes;
      return true;
    }
    const budget = this.policy.uploadBytesPerFrame;
    if (this.uploadStagingUsed + bytes > budget) {
      // 单次上传本身超过整帧预算时仍放行一次，否则该内容永远无法上传（饿死比超预算更糟）；
      // 但只在本帧尚未用额度时放行，避免突破成无界并发。
      if (this.uploadStagingUsed > 0) return false;
    }
    this.uploadStagingUsed += bytes;
    return true;
  }

  /** 本帧上传 staging 用量（诊断）。 */
  uploadStagingUsedBytes(): number {
    return this.uploadStagingUsed;
  }

  /** 单通道快照（诊断/测试）。 */
  channelSnapshot(channel: ResidencyChannel): ResidencySnapshot {
    return this.queueFor(channel).snapshot();
  }

  /** 是否所有通道都已空闲（含 draining 结束）。 */
  idle(): boolean {
    for (const queue of this.queues.values()) if (!queue.idle()) return false;
    return true;
  }

  /** 诊断快照（只含计数与估算，无内容）。 */
  diagnostics(): ResidencyDiagnostics {
    const byPurpose: Record<ResidencyPurpose, number> = { ...EMPTY_PURPOSE };
    for (const demand of this.demands.values()) byPurpose[demand.purpose] += 1;
    return {
      policy: this.policy,
      surfaceValid: this.surfaceValid,
      pageVisible: this.pageVisible,
      demands: this.demands.size,
      byPurpose,
      channels: [...this.queues.values()].map((queue) => queue.snapshot()),
      resident: this.demands.size,
      estimatedGpuBytes: this.estimateGpuBytes(),
      estimatedCpuBytes: this.estimateCpuBytes(),
      deferred: this.deferred,
      revoked: this.revoked,
      uploadStaging: { usedBytes: this.uploadStagingUsed, budgetBytes: this.policy.uploadBytesPerFrame }
    };
  }

  /** 幂等释放全部队列与需求。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeAll();
    this.queues.clear();
    this.demands.clear();
    this.pins.clear();
  }

  private estimateGpuBytes(): number {
    let total = 0;
    for (const demand of this.demands.values()) {
      const edge = selectThumbnailTier(demand.physicalEdge);
      total += edge * edge * 4;
    }
    return total;
  }

  private estimateCpuBytes(): number {
    return this.estimateGpuBytes();
  }

  private classify(
    candidate: ResidencyProjectionInput["candidates"][number],
    interactive: ReadonlySet<string>,
    pins: ReadonlySet<string>,
    view: { left: number; top: number; right: number; bottom: number } | null,
    insideView: { left: number; top: number; right: number; bottom: number } | null
  ): ResidencyPurpose | null {
    if (interactive.has(candidate.nodeId) || pins.has(candidate.nodeId)) return "interactive";
    // 无有效 surface 或页面隐藏：只保留 interactive/pin，暂停大批新预热（design D1）。
    if (!this.surfaceValid || !this.pageVisible || !view) return null;
    const right = candidate.x + candidate.width;
    const bottom = candidate.y + candidate.height;
    const intersects = (rect: { left: number; top: number; right: number; bottom: number }) =>
      right >= rect.left && candidate.x <= rect.right && bottom >= rect.top && candidate.y <= rect.bottom;
    // 视口内是 visible；仅落在预热余量里是 prefetch（design D1：预热首先让位）。
    if (insideView && intersects(insideView)) return "visible";
    return intersects(view) ? "prefetch" : null;
  }

  /**
   * 预算裁剪：interactive/pin 全保留；visible 按屏幕面积（大的优先，代表更值得驻留）排序；
   * warm/prefetch 只在剩余容量内保留。裁剪不删除文档节点，只影响重资源准入。
   *
   * 两个预算**分开**（design D3）：
   * - `previewSlots` 只限制需要离屏预览相机的需求（模型/复合资产）。图片与视频的纹理是卡片
   *   贴图，不占预览渲染槽；把预览槽当成全页媒体准入上限，会让视口内超过预览槽数量的卡片
   *   永远不被准入，只能靠 hover 提升为 interactive 才显示（真实故障：整屏卡片「hover 才能
   *   加载」）。
   * - `gpuDerivedBytes` 是**全页**估算预算，对两类需求合计生效。
   */
  private applyBudget(
    next: Map<string, NodeResidencyDemand>,
    pins: ReadonlySet<string>,
    candidatesById: ReadonlyMap<string, { previewSlot?: boolean }>
  ): Map<string, NodeResidencyDemand> {
    if (!next.size) return next;
    const slots = Math.max(1, Math.floor(this.policy.previewSlots));
    const ordered = [...next.values()].sort((a, b) => {
      const rank = purposeRankOf(a.purpose) - purposeRankOf(b.purpose);
      if (rank !== 0) return rank;
      // 同优先级按需求年龄稳定：先准入先保留，新增不能挤掉已驻留的同级需求。
      const admission = this.demands.get(a.nodeId);
      const other = this.demands.get(b.nodeId);
      const ageA = admission ? 0 : 1;
      const ageB = other ? 0 : 1;
      if (ageA !== ageB) return ageA - ageB;
      return b.physicalEdge - a.physicalEdge;
    });
    const admitted = new Map<string, NodeResidencyDemand>();
    let gpu = 0;
    let previewSlots = 0;
    for (const demand of ordered) {
      const pinned = demand.purpose === "interactive" || pins.has(demand.nodeId);
      // 只有明确声明需要离屏预览相机的需求才占用预览槽（生产路径由
      // `collectResidencyCandidates` 显式给出；图片/视频为 false）。
      const slot = candidatesById.get(demand.nodeId)?.previewSlot === true;
      if (!pinned) {
        // 预览槽只对需要离屏预览相机的需求计数；超槽的只有该项延后，不能中断整轮准入
        // （否则排在前面的第 17 个模型会让后面所有普通媒体卡一并被丢掉）。
        if (slot && previewSlots >= slots) continue;
        // GPU 估算预算：超预算时只对实际竞争需求排队，不无限扩大预算。
        const cost = estimateDemandBytes(demand);
        if (gpu + cost > this.policy.gpuDerivedBytes && admitted.size > 0) break;
        gpu += cost;
        if (slot) previewSlots += 1;
      }
      admitted.set(demand.nodeId, demand);
    }
    return admitted;
  }

  private queueFor(channel: ResidencyChannel): ResidencyChannelQueue {
    let queue = this.queues.get(channel);
    if (!queue) {
      queue = new ResidencyChannelQueue(channel, {
        concurrency: concurrencyLimit(this.policy, channel),
        byteBudget: byteBudget(this.policy, channel),
        ...(channel === "upload" ? { perFrameBytes: this.policy.uploadBytesPerFrame } : {})
      });
      this.queues.set(channel, queue);
    }
    return queue;
  }
}

/** 单个需求的 GPU 估算（按所选档位的 RGBA 面积；保守估算）。 */
function estimateDemandBytes(demand: NodeResidencyDemand): number {
  const edge = selectThumbnailTier(demand.physicalEdge);
  return edge * edge * 4;
}

function purposeRankOf(purpose: ResidencyPurpose): number {
  switch (purpose) {
    case "interactive": return 0;
    case "visible": return 1;
    case "prefetch": return 2;
    case "warm": return 3;
  }
}
