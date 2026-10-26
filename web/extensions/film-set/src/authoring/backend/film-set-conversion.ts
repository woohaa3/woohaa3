import { ownsShotMedia } from "../../state/shared/managed-shot-media.js";
/**
 * 单节点快捷「转为片场」的权威转换服务
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1–1.4 / design D3/D4/D5）。
 *
 * 统一处理三类来源：
 * - **model3d**：服务端权威复制为自包含片场（保留内部 part ID、placement 与镜头映射），
 *   不调用任何 LLM，也不要求账号/模型配置；
 * - **image/video**：把冻结来源交给可选生成端口（Section 2 的 adapter）产生候选，经完整校验后
 *   同一权威事务一次创建；失败绝不遗留空片场或中间节点。
 *
 * 幂等与恢复：
 * - 以 `(canvasId, requestId)` 持久绑定规范输入 hash、冻结来源、步骤、候选与首次回执；
 *   相同请求返回原任务/原结果，同 ID 不同输入拒绝（`request-id-reused`）；
 * - 提交经 `commandId = film-set-conversion:<canvasId>:<requestId>` 的 `submitDerived` 原子提交，
 *   重复提交命中 durable command 回执并回读同一结果；
 * - running 但本地无进行中任务（如服务重启）时状态为 `unknown`：先查询，不自动重新推理；
 *   已提交结果被取消时返回实际结果（提交边界为准）。
 *
 * 只复用既有 `CanvasCommand`（`node.add`）与 `CanvasAuthority.submitDerived`，不新增第二套命令。
 */
import type { CanvasAuthority } from "@woohaa3/contracts";
import type { CanvasCommand, CanvasNodeData, ModelContentVersion, ModelDefinition, ModelImportOrigin, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  createMotionSnapshot,
  decodeModel3DNodeData,
  filmSetConversionCapabilityRejectionCode,
  filmSetConversionInputHash,
  filmSetConversionNodeTaskStatus,
  filmSetConversionTitle,
  FILM_SET_CONVERSION_INSTRUCTION_VERSION,
  FILM_SET_CONVERSION_NODE_STATUS_FIELD,
  FILM_SET_NODE_TYPE,
  COMPOSITE_ASSET_NODE_TYPE,
  planFilmSetConversionPlacement,
  readFilmSetConversionSource,
  readFilmSetConversionNodeStatus,
  readModelCameras,
  validateFilmSetConversionCandidate,
  type FilmSetAnimationClip,
  type FilmSetConversionAdapterCapabilities,
  type FilmSetConversionErrorCode,
  type FilmSetConversionModelCandidate,
  type FilmSetConversionOriginRecord,
  type FilmSetConversionReceipt,
  type FilmSetConversionRecord,
  type FilmSetConversionRegistry,
  type FilmSetConversionRepair,
  type FilmSetConversionRequest,
  type FilmSetConversionSettings,
  type FilmSetConversionSourceKind,
  type FilmSetConversionStatus,
  type FilmSetConversionStatusResult,
  type FilmSetNodeData,
  type FilmSetLocalTransform,
  type InitialShotCamera,
  type ModelCamera,
  type ValidatedFilmSetConversionCandidate
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type { FilmSetConversionGenerationInput, FilmSetConversionGenerationResult, FilmSetConversionGenerator } from "@woohaa3/contracts";

// 生成端口契约由 `@woohaa3/contracts` 声明（拥有执行器的扩展与 Canvas 权威服务共用同一形状，
// 不互相 import 私有 service）；这里重导出，保持既有 `@woohaa3/extension-film-set/backend` 入口稳定。
export type {
  FilmSetConversionGenerationInput,
  FilmSetConversionGenerationResult,
  FilmSetConversionGenerator
};

export type FilmSetConversionServiceDependencies = {
  authorize?: (record: FilmSetConversionRecord) => Promise<boolean>;
  execution?: import("@woohaa3/contracts").ContentConversionExecutionPort;
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  registry: FilmSetConversionRegistry;
  /**
   * 图片/视频生成端口；缺失时图片/视频转换返回 `model-not-configured`（3D 仍可用）。
   *
   * 生成端口自身是所选模型/adapter 的权威，服务端在调用它之前另经 `resolveModelCapabilities`
   * 校验能力（见设计 D6）。
   */
  generator?: FilmSetConversionGenerator;
  /**
   * 转换模型能力目录（可选）：在调用上游之前解析本次实际使用的转换模型与其声明的视觉/
   * 结构化输出能力。
   *
   * 提供时，图片/视频转换在冻结来源之后、调用生成端口之前强制校验：
   * - 返回 `undefined`：没有任何可用转换模型 → `model-not-configured`；
   * - `capabilities` 缺失或不足以承担该来源 → `model-not-vision-capable` /
   *   `model-no-structured-output`。
   * 返回的 `modelKey` 被冻结为本次尝试的模型身份（与用户偏好区分，绝不写回源节点生成模型）。
   *
   * 缺省时按生成端口自身的边界处理（测试/无目录宿主的兼容路径）。
   */
  resolveModelCapabilities?: (input: {
    canvasId: string;
    sourceKind: FilmSetConversionSourceKind;
    modelKey?: string;
  }) => Promise<{ modelKey: string; capabilities?: FilmSetConversionAdapterCapabilities } | undefined>;
  /**
   * 当前可用转换模型候选（提供方集合的只读投影）。
   *
   * 供前端设置面板展示真实模型名并让用户选择/重新选择；缺省返回空数组（前端显示配置入口）。
   * 只读、无副作用；候选能力由提供方声明（与服务端门禁同源）。
   */
  listModels?: () => readonly FilmSetConversionModelCandidate[];
  now?: () => string;
  actorId?: string;
  /**
   * 「提交/重试」请求内等待生成的时间预算（毫秒）；超过即提前返回**进行中**状态，由占位节点上的
   * 权威状态继续跟踪，且**不掐断上游**。
   *
   * 视觉推理通常远超入口代理的单跳超时（dev/prod ingress 默认 30s），把整个推理塞进一次 HTTP
   * 请求会被入口掐断成无意义的通用错误。缺省 0：占位落地即受理，推理转后台。
   */
  submitBudgetMs?: number;
  /**
   * 显式部署的生成超时（毫秒）；缺省不设总时长上限，由停止操作或上游终态结束。
   */
  generationTimeoutMs?: number;
  /**
   * 结构归一成功但**完整校验失败**时，允许回喂错误并重新生成的有界修复轮数（缺省 2，即最多 3 次
   * 上游调用）。每次上游调用都是无状态回合，模型不会记得上一次输出，因此服务端把上一份候选与
   * 校验错误一并回喂，避免逐条在提示词里穷举场景隐式约束（胶囊高度、图元尺寸等）。
   */
};

/** 提交结果：3D 直接完成，图片/视频完成后返回终态；running/unknown 由状态查询继续跟踪。 */
export type FilmSetConversionSubmitOutcome =
  | { ok: true; receipt: Extract<FilmSetConversionReceipt, { ok: true }>; status: FilmSetConversionStatus }
  | { ok: false; code: FilmSetConversionErrorCode; message: string; retryable?: boolean };

export type FilmSetConversionCancelOutcome =
  | { ok: true; status: FilmSetConversionStatus }
  | { ok: false; code: FilmSetConversionErrorCode; message: string };

export class FilmSetConversionService {
  private readonly deps: FilmSetConversionServiceDependencies;
  private readonly actorId: string;
  /** 进行中的异步任务（图片/视频）；键为 `canvasId\0requestId`。重启后自然清空（真删除语义）。 */
  private readonly inFlight = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  /** 同一 `(canvasId, requestId)` 的提交串行化，防止双击并发推理。 */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly acceptances = new Map<string, { promise: Promise<void>; resolve(): void }>();
  private readonly commits = new Map<string, Promise<void>>();
  /** 「提交/重试」请求内等待生成的预算；超过返回进行中（不掐断上游）。 */
  private readonly submitBudgetMs: number;
  /** 显式部署的总时长预算；0 表示不限时。 */
  private readonly generationTimeoutMs: number;
  /** 完整校验失败时允许的回喂修复轮数（0 表示不修复，一次失败即终态）。 */

  constructor(deps: FilmSetConversionServiceDependencies) {
    this.deps = deps;
    this.actorId = deps.actorId ?? "canvas-model-mcp";
    const budget = deps.submitBudgetMs;
    this.submitBudgetMs = typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 0;
    const timeout = deps.generationTimeoutMs;
    this.generationTimeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : 0;
  }

  /**
   * 提交（或恢复）一次转换。
   *
   * 可信主体与画布写权限由 HTTP 边界负责（与 film-set import 同一写门禁）；这里做请求合法性、
   * 权威来源冻结与幂等。
   */
  submit(request: FilmSetConversionRequest): Promise<FilmSetConversionSubmitOutcome> {
    const guard = guardRequest(request);
    if (guard) return Promise.resolve(guard);
    return this.withChain(registryKey(request.canvasId, request.requestId), () => this.submitLocked(request));
  }

  private async submitLocked(request: FilmSetConversionRequest): Promise<FilmSetConversionSubmitOutcome> {
    const room = await this.deps.resolveRoom(request.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${request.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    let resolvedModelKey: string | undefined;
    let resolvedCapabilities: FilmSetConversionAdapterCapabilities | undefined;
    const existing = await this.deps.registry.get(request.canvasId, request.requestId);
    if (existing) {
      if (existing.inputHash !== requestInputHash(request) || existing.targetNodeId !== request.targetNodeId ||
          (existing.subject ?? existing.ownerId) !== (request.subject ?? request.ownerId)) {
        return { ok: false, code: "request-id-reused", message: "同一 requestId 不能用于不同输入" };
      }
      return this.resumeExisting(existing, room);
    }

    if (ownsShotMedia(exported.canvas, request.sourceNodeId)) return { ok: false, code: "unsupported-source", message: "片场镜头媒体不能再次创建片场" };
    // 冻结来源（权威读取；不猜测）。范围缺省=整个视频。
    const snapshot = readFilmSetConversionSource({
      canvas: exported.canvas,
      sourceNodeId: request.sourceNodeId,
      ...(request.settings?.range ? { range: request.settings.range } : {})
    });
    if (!snapshot.ok) return { ok: false, code: snapshot.code, message: snapshot.message };
    if (snapshot.source.kind !== request.sourceKind) {
      return { ok: false, code: "unsupported-source", message: "来源节点种类与请求不一致" };
    }

    // 能力门禁（design D6）：图片/视频在调用上游之前解析转换模型并校验视觉/结构化输出能力；
    // 3D 直接复制不依赖 LLM，跳过。缺省目录时按生成端口边界处理（不做额外拒绝）。
    if (snapshot.source.kind !== "model3d" && this.deps.resolveModelCapabilities) {
      const resolved = await this.deps.resolveModelCapabilities({
        canvasId: request.canvasId,
        sourceKind: snapshot.source.kind,
        ...(request.settings?.modelKey ? { modelKey: request.settings.modelKey } : {})
      });
      if (!resolved) {
        return { ok: false, code: "model-not-configured", message: "尚未配置支持视觉输入的转换模型", retryable: true };
      }
      const rejection = filmSetConversionCapabilityRejectionCode(snapshot.source.kind, resolved.capabilities);
      if (rejection) return { ok: false, code: rejection.code, message: rejection.message };
      resolvedModelKey = resolved.modelKey;
      resolvedCapabilities = resolved.capabilities;
    }

    const now = this.now();
    const record: FilmSetConversionRecord = {
      canvasId: request.canvasId,
      requestId: request.requestId,
      sourceNodeId: request.sourceNodeId,
      targetNodeId: request.targetNodeId,
      sourceKind: snapshot.source.kind,
      inputHash: requestInputHash(request),
      frozenSource: snapshot.source,
      title: snapshot.title,
      settings: normalizeSettings(request.settings),
      ...(request.subject ? { subject: request.subject } : {}),
      ...(request.ownerId ? { ownerId: request.ownerId } : {}),
      ...(resolvedModelKey ? { resolvedModelKey } : {}),
      ...(resolvedCapabilities ? { capabilities: resolvedCapabilities } : {}),
      step: "prepare-source",
      state: "running",
      attempt: 1,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.registry.put(record);

    if (snapshot.source.kind === "model3d") {
      // 3D 权威复制不依赖上游推理，同步完成。
      await this.runModelCopy(record, room, exported.canvas);
      return this.outcomeFromRecord(record, false);
    }
    // 受理响应必须以目标节点已经落地为边界；推理在后台继续，创建弹窗无需等待推理。
    if (this.deps.generator && !(await this.ensurePlaceholder(record, room))) return this.outcomeFromRecord(record, false);
    return this.awaitWithinSubmitBudget(record, this.runMediaConversion(record, room), false);
  }

  /**
   * 在「提交预算」内等待一次生成；超预算返回**进行中**状态（生成继续在后台完成）。
   *
   * 预算内完成时返回真实终态；超预算时不阻塞入口（避免被 ingress 单跳超时掐断成通用错误），
   * 由占位片场节点上的权威状态与状态查询继续跟踪。
   */
  private async awaitWithinSubmitBudget(
    record: FilmSetConversionRecord,
    generation: Promise<void>,
    duplicate: boolean
  ): Promise<FilmSetConversionSubmitOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      // 生成无论成功/失败都已写入终态，这里只关心「是否在预算内结束」。
      generation.then(() => false, () => false),
      ...(this.acceptances.has(registryKey(record.canvasId, record.requestId))
        ? [this.acceptances.get(registryKey(record.canvasId, record.requestId))!.promise.then(() => true)] : []),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), this.submitBudgetMs); })
    ]);
    if (timer) clearTimeout(timer);
    if (!expired) return this.outcomeFromRecord(record, duplicate);

    const current = await this.status({ canvasId: record.canvasId, requestId: record.requestId });
    return {
      ok: true,
      receipt: receiptOf(record, duplicate),
      status: current.ok && current.status
        ? current.status
        : { status: "unknown", requestId: record.requestId, sourceNodeId: record.sourceNodeId }
    };
  }

  /** 查询状态；running 但本地无进行中任务（重启/中断）返回 `unknown`（不自动重跑）。 */
  async status(input: { canvasId: string; requestId: string }): Promise<FilmSetConversionStatusResult> {
    if (!input.canvasId.trim() || !input.requestId.trim()) {
      return { ok: false, code: "malformed-request", message: "canvasId 与 requestId 不能为空" };
    }
    const record = await this.deps.registry.get(input.canvasId, input.requestId);
    if (!record) return { ok: true, status: null };
    if (record.state === "running" && !this.inFlight.has(registryKey(input.canvasId, input.requestId))) {
      const room = await this.deps.resolveRoom(record.canvasId);
      const completed = room ? this.readCommittedRecord(record, room) : null;
      if (completed) {
        await this.deps.registry.put(completed);
        this.deps.execution?.reconcile?.(completed, { status: "succeeded", receipt: completed.result });
        return { ok: true, status: toStatus(completed) };
      }
      if (this.deps.execution?.readStatus?.(record) === "cancelled") {
        const cancelled: FilmSetConversionRecord = { ...record, state: "cancelled", updatedAt: this.now() };
        await this.deps.registry.put(cancelled);
        await this.patchNodeStatus(cancelled, toStatus(cancelled));
        return { ok: true, status: toStatus(cancelled) };
      }
      return { ok: true, status: { status: "unknown", requestId: record.requestId, sourceNodeId: record.sourceNodeId, ...(record.execution ? { execution: record.execution } : {}) } };
    }
    return { ok: true, status: toStatus(record) };
  }

  /**
   * 取消未提交工作。
   *
   * 提交边界为准：已提交（`completed`）返回实际结果，不显示「已取消」掩盖持久结果。
   */
  async cancel(input: { canvasId: string; requestId: string }): Promise<FilmSetConversionCancelOutcome> {
    if (!input.canvasId.trim() || !input.requestId.trim()) {
      return { ok: false, code: "malformed-request", message: "canvasId 与 requestId 不能为空" };
    }
    const record = await this.deps.registry.get(input.canvasId, input.requestId);
    if (!record) return { ok: false, code: "unknown-result", message: "转换请求不存在" };
    if (record.state !== "running") {
      // 已完成/失败/取消：返回实际状态（已提交时由调用方走既有撤销入口）。
      return { ok: true, status: toStatus(record) };
    }
    this.inFlight.get(registryKey(input.canvasId, input.requestId))?.abort.abort();
    this.deps.execution?.cancel?.(record);
    const room = await this.deps.resolveRoom(record.canvasId);
    try { await this.commits.get(registryKey(input.canvasId, input.requestId)); }
    catch (error) { if (!room || !this.readCommittedRecord(record, room)) throw error; }
    const committed = room ? this.readCommittedRecord(record, room) : null;
    if (committed) {
      await this.deps.registry.put(committed).catch(() => undefined);
      this.deps.execution?.reconcile?.(committed, { status: "succeeded", receipt: committed.result });
      return { ok: true, status: toStatus(committed) };
    }
    const afterCommit = await this.deps.registry.get(input.canvasId, input.requestId);
    if (afterCommit?.state === "completed") return { ok: true, status: toStatus(afterCommit) };
    // 未提交取消：占位片场节点保留并以「已取消转换」呈现（design D4 表格：取消 → 已取消转换，
    // 提供重新转换），终态记录同样为 cancelled。
    const cancelled: FilmSetConversionRecord = { ...record, state: "cancelled", updatedAt: this.now() };
    await this.deps.registry.put(cancelled);
    await this.patchNodeStatus(record, {
      status: "cancelled",
      requestId: record.requestId,
      sourceNodeId: record.sourceNodeId
    });
    this.deps.execution?.reconcile?.(cancelled, { status: "cancelled" });
    return { ok: true, status: toStatus(cancelled) };
  }

  /** 等待全部进行中任务结束（优雅关闭/测试用）。 */
  async whenSettled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
  }

  /**
   * 当前可用转换模型候选（提供方集合的只读投影；前端设置面板据此展示真实模型名与可用性）。
   *
   * 只读、无副作用；未配置提供方时返回空数组，前端据此显示「连接 ChatGPT / 配置语言模型」入口。
   */
  listModels(): readonly FilmSetConversionModelCandidate[] {
    return this.deps.listModels?.() ?? [];
  }

  /**
   * 显式重试（design D5）。
   *
   * - 已提交（completed）：返回实际结果，不重复创建；
   * - running：返回当前状态（不并发重跑）；
   * - 失败且**已有合法候选**（保存失败）：复用候选尝试提交，不重复调用模型，尝试序号不变；
   * - 失败且无候选：产生新的尝试身份（attempt 递增）并重新推理；同 requestId/同输入仍受幂等登记约束。
   * - 取消：重试开启一次新的尝试（新的推理身份）。
   */
  async retry(input: { canvasId: string; requestId: string }): Promise<FilmSetConversionSubmitOutcome> {
    if (!input.canvasId.trim() || !input.requestId.trim()) {
      return { ok: false, code: "malformed-request", message: "canvasId 与 requestId 不能为空" };
    }
    return this.withChain(registryKey(input.canvasId, input.requestId), async () => {
      const room = await this.deps.resolveRoom(input.canvasId);
      if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
      const existing = await this.deps.registry.get(input.canvasId, input.requestId);
      if (!existing) return { ok: false, code: "unknown-result", message: "转换请求不存在，无法重试" };
      if (existing.state === "completed") return this.outcomeFromRecord(existing, true);
      if (existing.state === "running") return this.resumeExisting(existing, room);

      const retried: FilmSetConversionRecord = {
        ...existing,
        state: "running",
        step: "prepare-source",
        attempt: existing.candidate ? existing.attempt : existing.attempt + 1,
        updatedAt: this.now()
      };
      delete (retried as { error?: unknown }).error;
      delete retried.execution;
      if (existing.candidate) retried.saveAttempt = (existing.saveAttempt ?? 0) + 1;
      else delete retried.saveAttempt;
      await this.deps.registry.put(retried);

      if (existing.candidate) {
        if (this.deps.execution) return this.awaitWithinSubmitBudget(retried, this.runMediaConversion(retried, room), true);
        // 复用已校验候选：只重试权威提交，不重复调用模型。
        await this.updateRunning(retried, { step: "validate-and-save", candidate: existing.candidate });
        await this.commit(retried, room, existing.candidate, mediaProvenance(retried), existing.candidate.note);
      } else if (retried.sourceKind === "model3d") {
        const exported = room.exportCanvas();
        if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
        await this.runModelCopy(retried, room, exported.canvas);
      } else {
        return this.awaitWithinSubmitBudget(retried, this.runMediaConversion(retried, room), true);
      }
      return this.outcomeFromRecord(retried, true);
    });
  }

  // ---------------------------------------------------------------- 内部

  private async resumeExisting(
    existing: FilmSetConversionRecord,
    room: CanvasAuthority
  ): Promise<FilmSetConversionSubmitOutcome> {
    if (existing.state !== "running") {
      return this.outcomeFromRecord(existing, true);
    }
    const inflight = this.inFlight.get(registryKey(existing.canvasId, existing.requestId));
    if (inflight) {
      // 同一请求已在推理中：预算内等待真实终态，超时返回进行中（不重复推理、不阻塞入口）。
      return this.awaitWithinSubmitBudget(existing, inflight.promise, true);
    }
    if (existing.sourceKind === "model3d") {
      // 3D 无模型推理；重跑为幂等提交（命令回执保证最多创建一次）。
      const exported = room.exportCanvas();
      if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
      await this.runModelCopy(existing, room, exported.canvas);
      return this.outcomeFromRecord(existing, true);
    }
    // 图片/视频：结果未知，先查询，不自动重新推理。
    return {
      ok: true,
      receipt: receiptOf(existing, true),
      status: { status: "unknown", requestId: existing.requestId, sourceNodeId: existing.sourceNodeId }
    };
  }

  /** model3d 权威复制：保留 part ID/placement，映射持久镜头，原子创建独立片场。 */
  private async runModelCopy(
    record: FilmSetConversionRecord,
    room: CanvasAuthority,
    canvas: ServerCanvas
  ): Promise<void> {
    await this.updateRunning(record, { step: "prepare-source" });
    // design D4：3D 在「开始复制」时先创建占位片场节点，随后原地填入（成功即已交付）。
    if (!(await this.ensurePlaceholder(record, room))) return;
    const node = canvas.document.nodes.find((entry) => entry.id === record.sourceNodeId);
    const data = canvas.nodeData[record.sourceNodeId] as CanvasNodeData | undefined;
    const decoded = decodeModel3DNodeData(data);
    if (!node || !decoded.ok) {
      await this.fail(record, "source-not-ready", "来源模型不完整，无法复制", false);
      return;
    }
    await this.updateRunning(record, { step: "analyze-content" });
    const cameras = readModelCameras(data);
    const built = buildModelCopyCandidate({
      title: filmSetConversionTitle(record.title),
      model: decoded.value.model,
      cameras
    });
    await this.updateRunning(record, { step: "generate-film-set" });
    const validated = validateFilmSetConversionCandidate({
      candidate: built.candidate,
      canvas,
      scenePlacement: UNIT_SCENE_PLACEMENT,
      title: filmSetConversionTitle(record.title)
    });
    if (!validated.ok) {
      await this.fail(record, validated.code, validated.message, false);
      return;
    }
    await this.updateRunning(record, { step: "validate-and-save", candidate: validated.value });
    await this.commit(record, room, validated.value, built.provenance, built.note);
  }

  /** image/video：调用公开 adapter 生成候选，校验后同一事务提交。 */
  private async runMediaConversion(record: FilmSetConversionRecord, room: CanvasAuthority): Promise<void> {
    if (!this.deps.generator && !record.candidate) {
      // design D4：没有可用转换端口时不创建占位片场节点（首次使用的「配置模型」先于占位创建）。
      await this.fail(record, "model-not-configured", "尚未配置支持视觉输入的转换模型", true);
      return;
    }
    // 提交即创建占位片场节点（design D4）：先于任何上游调用，使进行中/失败有稳定落点。
    const key = registryKey(record.canvasId, record.requestId);
    const abort = new AbortController();
    if (this.deps.execution) {
      let resolve!: () => void;
      const accepted = new Promise<void>(done => { resolve = done; });
      this.acceptances.set(key, { promise: accepted, resolve });
    }
    const promise = this.generateAndCommit(record, room, abort);
    this.inFlight.set(key, { promise, abort });
    try {
      await promise;
    } finally {
      this.inFlight.delete(key);
      this.acceptances.delete(key);
    }
  }

  private async generateAndCommit(
    record: FilmSetConversionRecord,
    room: CanvasAuthority,
    abort: AbortController
  ): Promise<void> {
    // 只有部署显式指定预算才启动计时；默认允许长推理与长场景输出，用户仍可随时停止。
    const timeoutMs = this.generationTimeoutMs;
    let timeoutFail: Promise<void> | undefined;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (abort.signal.aborted) return;
      // 兜底：即便上游忽略 abort、promise 永不结束，记录也先落终态（占位节点随之可删除）。
      timeoutFail = this.fail(
        record,
        "generation-failed",
        `转换超时：上游在 ${Math.round(timeoutMs / 1000)} 秒内未返回结果，请重试`,
        true
      ).finally(() => abort.abort(new Error("film-set-conversion-timeout")));
    }, timeoutMs) : undefined;
    try {
      await this.runGeneration(record, room, abort);
    } catch (error) {
      if (!abort.signal.aborted) {
        await this.fail(record, "generation-failed", error instanceof Error ? error.message : "创建片场失败，请重试", true);
      }
    } finally {
      clearTimeout(timer);
    }
    // 上游在 abort 后收敛时，先等超时终态（记录 + 占位节点状态）落定再结束生成 promise，
    // 否则调用方（whenSettled/状态查询）可能观察到「记录已失败但节点仍进行中」的中间态。
    if (timeoutFail) await timeoutFail;
  }

  private async runGeneration(
    record: FilmSetConversionRecord,
    room: CanvasAuthority,
    abort: AbortController,
    context?: Parameters<Parameters<import("@woohaa3/contracts").ContentConversionExecutionPort["run"]>[1]>[0]
  ): Promise<void> {
    await this.updateRunning(record, { step: "prepare-source" });
    // 提交即创建占位片场节点（design D4）：先于任何上游调用，使进行中/失败有稳定落点。
    if (!(await this.ensurePlaceholder(record, room))) return;
    if (this.deps.execution && !context) {
      try {
        await this.deps.execution.run(record, async (executionContext) => {
          record.execution = executionContext.execution;
          const latest = (await this.deps.registry.get(record.canvasId, record.requestId)) ?? record;
          await this.deps.registry.put({ ...latest, execution: record.execution });
          const stop = () => abort.abort();
          executionContext.signal.addEventListener("abort", stop, { once: true });
          if (executionContext.signal.aborted) stop();
          let abortDone!: () => void;
          const aborted = new Promise<void>(resolve => { abortDone = resolve; });
          abort.signal.addEventListener("abort", abortDone, { once: true });
          if (abort.signal.aborted) abortDone();
          try {
            try {
              await Promise.race([this.runGeneration(record, room, abort, executionContext), aborted]);
            } catch (error) {
              // A lost response/projection write cannot undo an authoritative Canvas commit.
              if (!this.readCommittedRecord(record, room)) throw error;
            }
            // An admitted authoritative transaction must settle before cancellation can decide the parent.
            try { await this.commits.get(registryKey(record.canvasId, record.requestId)); }
            catch (error) { if (!this.readCommittedRecord(record, room)) throw error; }
            const committed = this.readCommittedRecord(record, room);
            if (committed?.result) {
              // This registry is a recoverable projection; the Canvas receipt and parent ledger
              // remain authoritative even while its storage is temporarily unavailable.
              await this.deps.registry.put(committed).catch(() => undefined);
              return { status: "succeeded", receipt: committed.result };
            }
            let settled = await this.deps.registry.get(record.canvasId, record.requestId);
            if (abort.signal.aborted && settled?.state === "running") {
              settled = { ...settled, state: "cancelled", updatedAt: this.now() };
              await this.deps.registry.put(settled);
              await this.patchNodeStatus(record, toStatus(settled));
            }
            if (settled?.state === "completed" && settled.result) return { status: "succeeded", receipt: settled.result };
            if (settled?.state === "failed") return { status: "failed", error: settled.error };
            return { status: abort.signal.aborted ? "cancelled" : "unknown" };
          } finally { executionContext.signal.removeEventListener("abort", stop); abort.signal.removeEventListener("abort", abortDone); }
        }, async execution => {
          record.execution = execution;
          const latest = (await this.deps.registry.get(record.canvasId, record.requestId)) ?? record;
          await this.deps.registry.put({ ...latest, execution });
          await this.patchNodeStatus(record, toStatus({ ...latest, execution }));
          this.acceptances.get(registryKey(record.canvasId, record.requestId))?.resolve();
        });
      } catch (error) {
        await this.fail(record, "generation-failed", error instanceof Error ? error.message : "助手执行未受理", true);
      }
      return;
    }
    if (abort.signal.aborted) return;
    if (record.candidate && record.saveAttempt) {
      context?.emit({ type: "stage", stage: "validate-and-save" });
      await this.updateRunning(record, { step: "validate-and-save", candidate: record.candidate });
      await this.commit(record, room, record.candidate, mediaProvenance(record), record.candidate.note, abort.signal);
      return;
    }
    const exported = room.exportCanvas();
    if (!exported.ok) {
      await this.fail(record, "canvas-unavailable", exported.message, true);
      return;
    }
    // 解析稳定媒体引用（storageKey/contentType）：真实内容到达模型的前提（design D2/D5）。
    const asset = record.frozenSource.assetId
      ? exported.canvas.assets.find((entry) => entry.id === record.frozenSource.assetId)
      : undefined;
    const storageKey = typeof asset?.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
    if (storageKey === "") {
      await this.fail(record, "source-not-ready", "来源素材缺少稳定存储引用", true);
      return;
    }
    const baseInput: Omit<FilmSetConversionGenerationInput, "repair"> = {
      canvasId: record.canvasId,
      requestId: record.requestId,
      frozenSource: record.frozenSource,
      title: filmSetConversionTitle(record.title),
      settings: record.settings,
      modelKey: record.resolvedModelKey ?? record.settings.modelKey ?? "",
      ...(record.capabilities ? { capabilities: record.capabilities } : {}),
      canvas: exported.canvas,
      media: { storageKey, contentType: mediaContentTypeHint(asset) },
      ...(record.subject ? { subject: record.subject } : {}),
      ...(record.ownerId ? { ownerId: record.ownerId } : {}),
      signal: abort.signal,
      ...(context ? { emit: context.emit } : {}),
      onStep: (step) => {
        context?.emit({ type: "stage", stage: step });
        void this.updateRunning(record, { step });
      }
    };
    // 结构归一成功但**完整校验失败**时，把校验错误与上一份候选回喂给模型继续修复
    // （change: 2026-10-22-remove-agent-execution-limits，任务 7.2 / design D7）：上游每次调用都是
    // 无状态回合、不会记得上一份输出，逐条在提示词里穷举场景隐式约束会一直漏。修复**不再有固定
    // 次数上限**：每次调用拥有稳定子尝试身份并关联同一父回合，直到候选通过完整校验、用户停止、
    // 权限/目标失效或上游真实失败。
    let repair: FilmSetConversionRepair | undefined;
    for (let round = 0; ; round += 1) {
      if (abort.signal.aborted) return;
      if (this.deps.authorize && !(await this.deps.authorize(record))) {
        await this.fail(record, "unauthorized", "画布写权限已失效，转换已停止", false); return;
      }
      context?.emit({ type: "stage", stage: round ? "repair-candidate" : "generate-film-set", detail: JSON.stringify({ childRequestId: `${context.execution.turnRequestId}:candidate:${round}`, ...(repair ? { diagnostic: repair.message, repairAttempt: round } : {}) }) });
      const result = await this.deps.generator!({
        ...baseInput,
        requestId: context ? `${context.execution.turnRequestId}:candidate:${round}` : baseInput.requestId,
        ...(repair ? { repair } : {})
      });
      if (abort.signal.aborted) return;
      if (!result.ok) {
        await this.fail(record, result.code, result.message, result.retryable ?? false);
        return;
      }
      await this.updateRunning(record, { step: "validate-and-save" });
      context?.emit({ type: "stage", stage: "validate-and-save" });
      const latest = room.exportCanvas();
      const validationCanvas = latest.ok ? latest.canvas : exported.canvas;
      const validated = validateFilmSetConversionCandidate({
        candidate: result.candidate,
        canvas: validationCanvas,
        scenePlacement: UNIT_SCENE_PLACEMENT,
        title: filmSetConversionTitle(record.title)
      });
      if (validated.ok) {
        await this.updateRunning(record, { candidate: validated.value });
        const note = result.note ?? validated.value.note;
        await this.commit(record, room, validated.value, mediaProvenance(record), note, abort.signal);
        return;
      }
      // 不按修复次数终止：携带上一候选与具体诊断继续同一父回合的下一子尝试。
      repair = { candidate: result.candidate, message: validated.message, attempt: round + 1 };
    }
  }

  /**
   * 提交/复制开始时创建占位片场节点（design D4）。
   *
   * 在同一权威事务里于源节点旁的空位创建 `composite-asset + extensionId=film-set` 目标节点，
   * 初始为空内容并携带 running 状态（`prepare-source`）。命令 id 与「原地填入」分离：重复提交
   * 命中 durable 回执不会误跳过填入。
   *
   * 来源节点在权威提交前已删除（删除/提交竞态）时返回 `false`（不创建占位）；占位节点已存在但
   * 来源已删除时移除占位并失败（不保留占位）。
   */
  private async ensurePlaceholder(
    record: FilmSetConversionRecord,
    room: CanvasAuthority
  ): Promise<boolean> {
    const existing = room.exportCanvas();
    if (!existing.ok) {
      await this.fail(record, "canvas-unavailable", existing.message, true);
      return false;
    }
    const sourcePresent = existing.canvas.document.nodes.some((entry) => entry.id === record.sourceNodeId);
    const already = existing.canvas.document.nodes.some((entry) => entry.id === record.targetNodeId);
    if (already) {
      if (sourcePresent) return true;
      await this.removePlaceholder(record, room, "source-deleted");
      await this.fail(record, "source-not-found", "来源节点已删除", false);
      return false;
    }

    const commandId = conversionPlaceholderCommandId(record.canvasId, record.requestId);
    const status: FilmSetConversionStatus = {
      status: "running",
      requestId: record.requestId,
      sourceNodeId: record.sourceNodeId,
      step: "prepare-source"
    };
    const result = await room.submitDerived({
      commandId,
      derive: (live) => {
        // 幂等：目标已存在（先前同 requestId 提交）时不重复创建。
        if (live.document.nodes.some((entry) => entry.id === record.targetNodeId)) {
          return { ok: true, batch: emptyBatch(record.canvasId, commandId, this.actorId, live.revision) };
        }
        // 提交边界复核：来源节点仍存在（删除/提交竞态），否则拒绝且不创建占位。
        if (ownsShotMedia(live, record.sourceNodeId)) return { ok: false, code: "unsupported-source", message: "片场镜头媒体不能再次创建片场" };
        const source = readFilmSetConversionSource({ canvas: live, sourceNodeId: record.sourceNodeId });
        if (!source.ok) return { ok: false, code: source.code, message: source.message };
        const position = planFilmSetConversionPlacement(live, record.sourceNodeId);
        if (!position) return { ok: false, code: "source-not-found", message: "来源节点已删除，无法放置片场" };
        return {
          ok: true,
          batch: buildBatch(record.canvasId, commandId, this.actorId, live.revision, [{
            type: "node.add",
            node: { id: record.targetNodeId, type: COMPOSITE_ASSET_NODE_TYPE, position },
            nodeData: {
              ...canonicalFilmSetFields(placeholderFilmSetData(filmSetConversionTitle(record.title))),
              filmSetConversionRequest: {
                canvasId: record.canvasId, requestId: record.requestId, sourceNodeId: record.sourceNodeId,
                targetNodeId: record.targetNodeId, sourceKind: record.sourceKind, settings: record.settings
              },
              ...nodeStatusFields(status)
            } as CanvasNodeData
          }])
        };
      }
    });
    if (!result.ok) {
      // 来源删除竞态（提交边界复核失败）：停止未提交转换且不保留占位节点。
      await this.fail(record, result.code === "source-not-found" ? "source-not-found" : "commit-failed", result.message, false);
      return false;
    }
    return true;
  }

  /**
   * 移除占位片场节点（取消或源节点删除竞态；design D4「不保留占位节点」）。
   *
   * 只移除**仍是占位**的目标节点：源节点删除/取消发生在内容填入之前。若目标已填入完整内容
   * （持久化转换状态为 completed）则不动它（已交付结果继续独立存在）。
   */
  private async removePlaceholder(
    record: FilmSetConversionRecord,
    room: CanvasAuthority,
    reason: string
  ): Promise<void> {
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    const target = exported.canvas.document.nodes.find((entry) => entry.id === record.targetNodeId);
    if (!target) return;
    const data = exported.canvas.nodeData[record.targetNodeId] as CanvasNodeData | undefined;
    if (data?.[FILM_SET_CONVERSION_NODE_STATUS_FIELD] !== undefined
      && (data[FILM_SET_CONVERSION_NODE_STATUS_FIELD] as { status?: unknown }).status === "completed") {
      return;
    }
    const commandId = conversionPlaceholderRemovalCommandId(record.canvasId, record.requestId);
    await room.submitDerived({
      commandId,
      derive: (live) => {
        if (!live.document.nodes.some((entry) => entry.id === record.targetNodeId)) {
          return { ok: true, batch: emptyBatch(record.canvasId, commandId, this.actorId, live.revision) };
        }
        return {
          ok: true,
          batch: buildBatch(record.canvasId, commandId, this.actorId, live.revision, [
            // 任务边界保护（`edit-active-run`）只看 taskStatus：占位仍在 processing 时先落终态再删除。
            { type: "nodeData.patch", nodeId: record.targetNodeId, value: { taskStatus: "cancelled" } },
            // 目标可能是 group 成员，删除前先解除 parent 引用（否则 group 校验拒绝整批）。
            { type: "node.update", nodeId: record.targetNodeId, parentId: null },
            { type: "node.remove", nodeIds: [record.targetNodeId] }
          ])
        };
      }
    });
    void reason;
  }

  /**
   * 权威原子「原地填入」：占位节点已存在（design D4），成功时在同一 `nodeId` 上 patch 完整片场
   * 内容与来源 metadata，并写入 completed 状态；MUST NOT 新增第二个节点。
   *
   * 占位节点在提交/竞态中已被移除（源节点删除）时返回明确失败，不重新创建。
   */
  private commit(
    record: FilmSetConversionRecord, room: CanvasAuthority, candidate: ValidatedFilmSetConversionCandidate,
    provenance: FilmSetConversionOriginRecord, note: string | undefined, signal?: AbortSignal
  ): Promise<void> {
    const key = registryKey(record.canvasId, record.requestId);
    const promise = this.commitCandidate(record, room, candidate, provenance, note, signal).finally(() => {
      if (this.commits.get(key) === promise) this.commits.delete(key);
    });
    this.commits.set(key, promise);
    return promise;
  }

  private async commitCandidate(
    record: FilmSetConversionRecord,
    room: CanvasAuthority,
    candidate: ValidatedFilmSetConversionCandidate,
    provenance: FilmSetConversionOriginRecord,
    note: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const commandId = conversionCommandId(record.canvasId, record.requestId);
    if (this.deps.authorize && !(await this.deps.authorize(record))) {
      await this.fail(record, "unauthorized", "画布写权限已失效，结果未保存", false); return;
    }
    const title = filmSetConversionTitle(record.title);
    const animation: FilmSetNodeData = {
      ...filmSetDataFromCandidate(candidate, title),
      origin: provenanceOrigin(record, provenance)
    };
    const status: FilmSetConversionStatus = {
      status: "completed",
      requestId: record.requestId,
      sourceNodeId: record.sourceNodeId,
      targetNodeId: record.targetNodeId,
      commandId,
      ...(note ? { note } : {}),
      ...(record.execution ? { execution: record.execution } : {})
    };
    const result = await room.submitDerived({
      commandId,
      derive: (live) => {
        if (signal?.aborted) return { ok: false, code: "cancelled", message: "转换已停止" };
        if (!live.document.nodes.some((entry) => entry.id === record.targetNodeId)) {
          // 占位节点已被移除（例如源节点删除竞态）：不重新创建，返回明确失败。
          return { ok: false, code: "source-not-found", message: "目标片场节点已不存在，无法填入内容" };
        }
        // 提交边界复核：来源节点已删除时停止未提交工作，且不得在占位节点上留下完整内容
        // （design D4/D5：已交付结果才继续独立存在；未交付的删除竞态不保留）。
        if (!live.document.nodes.some((entry) => entry.id === record.sourceNodeId)) {
          return { ok: false, code: "source-not-found", message: "来源节点已删除，无法填入内容" };
        }
        return {
          ok: true,
          batch: buildBatch(record.canvasId, commandId, this.actorId, live.revision, [{
            type: "nodeData.patch",
            nodeId: record.targetNodeId,
            value: {
              ...canonicalFilmSetFields(animation),
              ...nodeStatusFields(status)
            } as CanvasNodeData
          }])
        };
      }
    });
    if (!result.ok) {
      if (signal?.aborted && result.code === "cancelled") return;
      if (result.code === "source-not-found") {
        // 来源删除竞态：不保留占位片场节点（design D4/D5）。
        await this.removePlaceholder(record, room, "source-deleted");
        await this.fail(record, "source-not-found", result.message, false);
      } else {
        await this.fail(record, "commit-failed", result.message, false);
      }
      return;
    }
    // 权威回读：确认片场身份真实存在（不凭模型文字输出当作成功）。
    const latest = room.exportCanvas();
    if (!latest.ok || !latest.canvas.document.nodes.some((entry) => entry.id === record.targetNodeId)) {
      await this.fail(record, "commit-failed", "提交后未能读回片场节点", false);
      return;
    }
    const completed: FilmSetConversionRecord = {
      ...record,
      step: "validate-and-save",
      state: "completed",
      updatedAt: this.now(),
      result: {
        targetNodeId: record.targetNodeId,
        commandId,
        ...(note ? { note } : {})
      }
    };
    await this.deps.registry.put(completed);
  }

  private async outcomeFromRecord(
    record: FilmSetConversionRecord,
    duplicate: boolean
  ): Promise<FilmSetConversionSubmitOutcome> {
    const settled = (await this.deps.registry.get(record.canvasId, record.requestId)) ?? record;
    if (settled.state === "failed" && settled.error) {
      return {
        ok: false,
        code: settled.error.code,
        message: settled.error.message,
        retryable: settled.error.retryable
      };
    }
    const status = settled.state === "running"
      ? { status: "unknown" as const, requestId: settled.requestId, sourceNodeId: settled.sourceNodeId }
      : toStatus(settled);
    return { ok: true, receipt: receiptOf(settled, duplicate), status };
  }

  private async updateRunning(
    record: FilmSetConversionRecord,
    patch: Partial<Pick<FilmSetConversionRecord, "step" | "candidate">>
  ): Promise<void> {
    const current = (await this.deps.registry.get(record.canvasId, record.requestId)) ?? record;
    if (current.state !== "running") return;
    await this.deps.registry.put({ ...current, ...patch, updatedAt: this.now() });
    // 进行中阶段就近显示在占位片场节点上（design D4）；占位尚未创建时自动跳过。
    await this.patchNodeStatus(record, {
      status: "running",
      requestId: current.requestId,
      sourceNodeId: current.sourceNodeId,
      step: patch.step ?? current.step
    });
  }

  private async fail(
    record: FilmSetConversionRecord,
    code: FilmSetConversionErrorCode,
    message: string,
    retryable: boolean
  ): Promise<void> {
    const persisted = (await this.deps.registry.get(record.canvasId, record.requestId)) ?? record;
    const current = { ...persisted, ...(persisted.execution ?? record.execution ? { execution: persisted.execution ?? record.execution } : {}) };
    if (current.state !== "running") return;
    await this.deps.registry.put({
      ...current,
      state: "failed",
      updatedAt: this.now(),
      error: { code, message, retryable }
    });
    // 失败保留占位片场节点并在其上显示具体原因与恢复动作（design D4）。
    await this.patchNodeStatus(record, {
      status: "failed",
      requestId: current.requestId,
      sourceNodeId: current.sourceNodeId,
      code,
      message,
      attempt: current.attempt,
      retryable
    });
    this.deps.execution?.reconcile?.(current, { status: "failed", error: { code, message } });
  }

  private readCommittedRecord(record: FilmSetConversionRecord, room: CanvasAuthority): FilmSetConversionRecord | null {
    const exported = room.exportCanvas();
    const status = exported.ok ? readFilmSetConversionNodeStatus(exported.canvas.nodeData[record.targetNodeId]) : null;
    if (status?.status !== "completed" || status.requestId !== record.requestId || status.commandId !== conversionCommandId(record.canvasId, record.requestId)) return null;
    return { ...record, state: "completed", step: "validate-and-save", updatedAt: this.now(),
      result: { targetNodeId: record.targetNodeId, commandId: status.commandId, ...(status.note ? { note: status.note } : {}) } };
  }

  /**
   * 把转换状态投影到占位片场节点（design D4）。占位不存在（未创建/已移除）时静默跳过。
   *
   * 每个状态/阶段用含 `attempt` 与 stage 的命令 id 单独幂等，重复提交不重复应用，也不会互相
   * 覆盖导致阶段回退。只写该节点，不新增节点、不改画布其它内容。
   */
  private async patchNodeStatus(record: FilmSetConversionRecord, status: FilmSetConversionStatus): Promise<void> {
    if (record.execution) status = { ...status, execution: record.execution };
    const room = await this.deps.resolveRoom(record.canvasId);
    if (!room) return;
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    if (!exported.canvas.document.nodes.some((entry) => entry.id === record.targetNodeId)) return;
    const stage = status.status === "running" ? `running-${status.step}` : status.status;
    const commandId = conversionNodeStatusCommandId(record.canvasId, record.requestId, record.attempt, `${stage}${record.execution ? ":linked" : ""}`);
    await room.submitDerived({
      commandId,
      derive: (live) => {
        if (!live.document.nodes.some((entry) => entry.id === record.targetNodeId)) {
          return { ok: true, batch: emptyBatch(record.canvasId, commandId, this.actorId, live.revision) };
        }
        return {
          ok: true,
          batch: buildBatch(record.canvasId, commandId, this.actorId, live.revision, [{
            type: "nodeData.patch",
            nodeId: record.targetNodeId,
            value: nodeStatusFields(status)
          }])
        };
      }
    });
  }

  /** 串行化同一 requestId 的提交；前一个失败不阻塞后续。 */
  private withChain<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

// ------------------------------------------------------------------ 纯函数

/** 转换命令 id：稳定绑定 requestId，保证重复提交命中同一 durable 回执。 */
export function conversionCommandId(canvasId: string, requestId: string): string {
  return `film-set-conversion:${canvasId}:${requestId}`;
}

/**
 * 占位片场节点创建命令 id（design D4）。
 *
 * 与「原地填入内容」的 {@link conversionCommandId} **分离**：占位创建在提交/开始复制时先行完成，
 * 成功时再用另一命令在**同一节点身份**上 patch 完整内容，避免 durable 回执把「创建」误当成
 * 「已填入」而跳过写入。
 */
export function conversionPlaceholderCommandId(canvasId: string, requestId: string): string {
  return `film-set-conversion-placeholder:${canvasId}:${requestId}`;
}

/** 移除占位片场节点命令 id（源节点删除/提交竞态；不保留占位）。 */
export function conversionPlaceholderRemovalCommandId(canvasId: string, requestId: string): string {
  return `film-set-conversion-placeholder-remove:${canvasId}:${requestId}`;
}

/**
 * 占位节点状态 patch 命令 id。
 *
 * 含 `attempt` 与 `stage`（running 阶段还含 step），使每个状态/阶段各自幂等且互不覆盖；同一
 * requestId 的重复写入命中 durable 回执不再重复应用。
 */
export function conversionNodeStatusCommandId(
  canvasId: string,
  requestId: string,
  attempt: number,
  stage: string
): string {
  return `film-set-conversion-node-status:${canvasId}:${requestId}:${attempt}:${stage}`;
}

const UNIT_SCENE_PLACEMENT: FilmSetLocalTransform = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };

function registryKey(canvasId: string, requestId: string): string {
  return `${canvasId}\u0000${requestId}`;
}

function requestInputHash(request: FilmSetConversionRequest): string {
  return filmSetConversionInputHash(request);
}

function normalizeSettings(settings: FilmSetConversionSettings | undefined): FilmSetConversionSettings {
  if (!settings) return {};
  return {
    ...(settings.connection ? { connection: { ...settings.connection } } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings.modelKey ? { modelKey: settings.modelKey } : {}),
    ...(settings.instruction ? { instruction: settings.instruction } : {}),
    ...(settings.range ? { range: { ...settings.range } } : {})
  };
}

function guardRequest(
  request: FilmSetConversionRequest
): { ok: false; code: FilmSetConversionErrorCode; message: string } | null {
  if (!request.canvasId?.trim()) return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (!request.requestId?.trim()) return { ok: false, code: "malformed-request", message: "requestId 不能为空" };
  if (!request.sourceNodeId?.trim()) return { ok: false, code: "malformed-request", message: "sourceNodeId 不能为空" };
  if (!request.targetNodeId?.trim()) return { ok: false, code: "malformed-request", message: "targetNodeId 不能为空" };
  return null;
}

/** 由已校验候选构造完整片场 nodeData（items-only；origin 由提交阶段附加）。 */
function filmSetDataFromCandidate(
  candidate: ValidatedFilmSetConversionCandidate,
  title: string
): FilmSetNodeData {
  const collection = candidate.filmSetAnimations;
  const clip = collection.clips.find((entry) => entry.id === collection.defaultClipId);
  return {
    kind: FILM_SET_NODE_TYPE,
    title,
    scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    sceneCamera: candidate.sceneCamera,
    camera: clip?.initialCamera ?? candidate.sceneCamera,
    timeline: clip?.timeline ?? { duration: 0, loop: false },
    filmSetContent: candidate.filmSetContent,
    filmSetAnimations: collection
  };
}

/**
 * 占位片场节点的初始定义：空内容（无默认几何）、空片段集合、默认镜头（design D4）。
 *
 * `origin` 留待成功填入时写入（占位本身不声称已交付来源内容）；通过既有片场 decoder 校验。
 */
function placeholderFilmSetData(title: string): FilmSetNodeData {
  return createFilmSetSnapshot({ title, timeline: { duration: 0, loop: false } });
}

/** 把转换状态映射到占位节点的持久化字段（`filmSetConversion` + 通用 `taskStatus`/`progress`）。 */
function nodeStatusFields(status: FilmSetConversionStatus): CanvasNodeData {
  return {
    [FILM_SET_CONVERSION_NODE_STATUS_FIELD]: status,
    taskStatus: filmSetConversionNodeTaskStatus(status)
  } as CanvasNodeData;
}

function provenanceOrigin(
  record: FilmSetConversionRecord,
  provenance: FilmSetConversionOriginRecord
): ModelImportOrigin {  return {
    sourceNodeId: record.sourceNodeId,
    importedModelContentHash: record.frozenSource.contentHash,
    importedAt: record.updatedAt,
    conversion: { ...provenance, requestId: record.requestId }
  };
}

function receiptOf(
  record: FilmSetConversionRecord,
  duplicate: boolean
): Extract<FilmSetConversionReceipt, { ok: true }> {
  return {
    ok: true,
    requestId: record.requestId,
    targetNodeId: record.targetNodeId,
    commandId: conversionCommandId(record.canvasId, record.requestId),
    duplicate
  };
}

function toStatus(record: FilmSetConversionRecord): FilmSetConversionStatus {
  return { ...toStatusWithoutExecution(record), ...(record.execution ? { execution: record.execution } : {}) };
}

function toStatusWithoutExecution(record: FilmSetConversionRecord): FilmSetConversionStatus {
  if (record.state === "completed" && record.result) {
    return {
      status: "completed",
      requestId: record.requestId,
      sourceNodeId: record.sourceNodeId,
      targetNodeId: record.result.targetNodeId,
      commandId: record.result.commandId,
      ...(record.result.note ? { note: record.result.note } : {})
    };
  }
  if (record.state === "failed" && record.error) {
    return {
      status: "failed",
      requestId: record.requestId,
      sourceNodeId: record.sourceNodeId,
      code: record.error.code,
      message: record.error.message,
      attempt: record.attempt,
      retryable: record.error.retryable
    };
  }
  if (record.state === "cancelled") {
    return { status: "cancelled", requestId: record.requestId, sourceNodeId: record.sourceNodeId };
  }
  return { status: "running", requestId: record.requestId, sourceNodeId: record.sourceNodeId, step: record.step };
}

/**
 * model3d 复制候选（design D3）。
 *
 * 一个 model item 保留源模型完整定义（内部 part ID、placement 由快照携带）；持久镜头映射为
 * 片场片段镜头能力（每个镜头一个静态片段，默认片段为第一个），首个镜头同时作为 `sceneCamera`。
 * 无持久镜头时使用片场默认构图。无法映射的镜头记入来源 metadata 并明确说明。
 */
export function buildModelCopyCandidate(input: {
  title: string;
  model: ModelDefinition;
  cameras: readonly ModelCamera[];
}): { candidate: unknown; provenance: FilmSetConversionOriginRecord; note?: string } {
  const base = createFilmSetSnapshot({
    title: input.title,
    model: {
      modelScript: input.model.modelScript,
      modelScriptVersion: input.model.modelScriptVersion,
      placement: input.model.placement
    },
    modelItemId: "model",
    modelItemName: input.title,
    timeline: { duration: 0, loop: false },
    ...(input.cameras.length > 0 ? { initialCamera: toInitialCamera(input.cameras[0]!) } : {})
  });
  const modelItemVersion = modelItemContentVersion(base);
  const clips: FilmSetAnimationClip[] = [];
  const unmapped: string[] = [];
  for (const [index, camera] of input.cameras.entries()) {
    const initialCamera = toInitialCamera(camera);
    if (!initialCamera || !isUsableCamera(camera)) {
      unmapped.push(camera.name);
      continue;
    }
    clips.push({
      id: `camera-${index + 1}`,
      name: camera.name.slice(0, 80),
      kind: "static",
      timeline: { duration: 0, loop: false },
      initialCamera,
      cameraMotion: createMotionSnapshot({
        motionScript: "",
        basedOnModelVersion: modelItemVersion
      }),
      bindings: []
    });
  }
  const filmSetAnimations = clips.length > 0
    ? { schemaVersion: 3 as const, defaultClipId: clips[0]!.id, clips }
    : base.filmSetAnimations;
  const note = unmapped.length > 0
    ? `部分镜头未能映射为片场镜头：${unmapped.join("、")}`
    : undefined;
  return {
    candidate: {
      filmSetContent: base.filmSetContent,
      filmSetAnimations,
      sceneCamera: base.sceneCamera,
      ...(note ? { note } : {})
    },
    provenance: {
      requestId: "",
      sourceKind: "model3d",
      sourceHash: input.model.contentVersion.sourceHash,
      ...(unmapped.length > 0 ? { unmappedCameras: unmapped } : {})
    },
    ...(note ? { note } : {})
  };
}

function modelItemContentVersion(data: FilmSetNodeData): ModelContentVersion {
  const item = data.filmSetContent.items.find((entry) => entry.kind === "model");
  if (item && item.kind === "model") return item.model.contentVersion;
  return { revision: 1, sourceHash: "", contentHash: "" };
}

function isUsableCamera(camera: ModelCamera): boolean {
  return Number.isFinite(camera.azimuth)
    && Number.isFinite(camera.elevation)
    && camera.elevation >= -Math.PI / 2
    && camera.elevation <= Math.PI / 2
    && camera.distance > 0
    && camera.name.trim().length > 0
    && camera.name.trim().length <= 80;
}

function toInitialCamera(camera: ModelCamera): InitialShotCamera {
  return {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    distance: camera.distance,
    aspect: camera.aspect,
    focusOffset: { ...(camera.focusOffset ?? { x: 0, y: 0, z: 0 }) }
  };
}

/** 资产 contentType 提示：metadata 优先，否则按 mediaKind 推断；仅供读取器选择解码路径。 */
function mediaContentTypeHint(asset: StoredAsset | undefined): string {
  const declared = asset?.metadata?.contentType;
  if (typeof declared === "string" && declared.includes("/")) return declared;
  if (asset?.mediaKind === "image") return "image/*";
  if (asset?.mediaKind === "video") return "video/*";
  return "";
}

function mediaProvenance(record: FilmSetConversionRecord): FilmSetConversionOriginRecord {
  return {
    requestId: record.requestId,
    sourceKind: record.sourceKind,
    sourceHash: record.frozenSource.contentHash,
    ...((record.resolvedModelKey ?? record.settings.modelKey)
      ? { modelKey: record.resolvedModelKey ?? record.settings.modelKey }
      : {}),
    instructionVersion: FILM_SET_CONVERSION_INSTRUCTION_VERSION,
    ...(record.frozenSource.range ? { range: { ...record.frozenSource.range } } : {})
  };
}

function buildBatch(
  canvasId: string,
  commandId: string,
  actorId: string,
  baseRevision: number,
  commands: CanvasCommand[]
): CanvasCommandBatch {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, baseRevision, actorId, commands };
}

/** 幂等无操作批次（目标已存在时不重复创建，但仍推进 durable 回执）。 */
function emptyBatch(
  canvasId: string,
  commandId: string,
  actorId: string,
  baseRevision: number
): CanvasCommandBatch {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, baseRevision, actorId, commands: [] };
}
