/**
 * 服务端 canvas room（任务 4.1–4.5 / design D2、D6；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R27 —— 抽出类型、
 *  命令管线与 checkpoint，本文件保留唯一 doc/revision owner 与 queue/load/dispose）。
 *
 * 每个 canvas 一个 room，**串行**执行命令：同 room 的命令绝不交错，不同 room 可并行。
 * 这与 design D2「服务端在最新 published 状态上串行验证整个命令批次」是同一件事。
 *
 * 双文档模型（design D6）：
 * - **published**：只包含已持久化 update，用于同步与导出；任何时刻都可作为权威读取源。
 * - **authoring**：published 的可写候选副本。命令在这里形成事务；只有持久化成功后，
 *   才把同一个 update 应用到 published 并广播。提交失败则丢弃 authoring，从 published 重建。
 *
 * 因此「持久化先于确认和广播」是结构性的：published 只在 durable 之后前进。
 */
import * as Y from "yjs";
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeUpdateSha256, type YjsCommandRecord, type YjsDocumentRepository } from "./yjs-repository.js";
import { recoverYjsDocument, compactYjsCheckpoint } from "./recovery.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SHARED_TYPES, createRoomEpoch } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { executeCommand, executeDerived, type RoomExecutionHost } from "./command-execution.js";
import type { CanvasRoomOptions, CanvasRoomState, ExternalUpdateResult, RoomCommandResult, RoomSubmitOptions } from "./room-types.js";
import type { MediaStorage } from "@woohaa3/contracts";
import type { ModelScriptBatchMeta, CanvasScriptSubmissionMeta } from "@woohaa3/contracts";

export type {
  RoomCommandResult,
  RoomBroadcast,
  RoomUpdateOrigin,
  ExternalUpdateResult,
  RoomSubmitOptions,
  CanvasRoomState,
  CanvasRoomOptions
} from "./room-types.js";

/** 上游合入的 update 写入幂等记录时使用的 actor；commandId 为 `upstream:<sha256>`。 */
export const UPSTREAM_ACTOR_ID = "sync-upstream";

/**
 * 存储 sequence 冲突后自动重载 room 的次数上限。
 *
 * 冲突只说明「持久层被别的 writer 推进了」，本 room 的 published 可能落后。重载后重新执行
 * 同一批次是安全的（命令/update 都幂等），但持续竞争时不能无限重试：超过上限就把冲突
 * 如实返回，由客户端决定是否再试。
 */
const MAX_STORAGE_SEQ_RECOVERIES = 2;

export class CanvasRoom {
  readonly canvasId: string;
  private readonly repository: YjsDocumentRepository;
  private readonly mediaStorage?: MediaStorage;
  private readonly now: () => string;
  private readonly onCommitted?: (input: { canvas: ServerCanvas; commands: readonly unknown[] }) => void;
  private readonly onDelta?: (input: { before: ServerCanvas; after: ServerCanvas }) => void;
  private readonly onStorageSeqRecovered?: CanvasRoomOptions["onStorageSeqRecovered"];
  private readonly broadcast: CanvasRoomOptions["broadcast"];
  private readonly verifyAssets: boolean;
  private readonly bootstrap: (() => Promise<ServerCanvas | null>) | undefined;
  private readonly seedFromUpstream: (() => Promise<Uint8Array | null>) | undefined;
  private readonly generateRoomEpoch: () => string;

  private state: CanvasRoomState = "loading";
  private quarantineReason: string | null = null;
  /** 隔离原因的结构化错误码（`not-found` 表示画布文档已经不存在），供调用方区分可重试与终态。 */
  private quarantineCode: string | null = null;
  /** 只含已持久化 update 的权威文档。 */
  private published: Y.Doc;
  private storageSeq = 0;
  private revision = 0;
  private epoch: string | null = null;

  /** 命令序列化：同 room 的命令排队执行。 */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly content: import("@woohaa3/contracts").ContentContributionResolver | undefined;
  private readonly lifecycle: import("@woohaa3/contracts").ManagedNodeLifecycleResolver | undefined;
  constructor(options: CanvasRoomOptions) {
    this.content = options.content;
    this.lifecycle = options.lifecycle;
    this.canvasId = options.canvasId;
    this.repository = options.repository;
    this.mediaStorage = options.mediaStorage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.broadcast = options.broadcast;
    this.verifyAssets = options.verifyAssets ?? true;
    this.bootstrap = options.bootstrap;
    this.seedFromUpstream = options.seedFromUpstream;
    this.generateRoomEpoch = options.generateRoomEpoch ?? (() => createRoomEpoch());
    this.onCommitted = options.onCommitted;
    this.onDelta = options.onDelta;
    this.onStorageSeqRecovered = options.onStorageSeqRecovered;
    this.published = new Y.Doc();
  }

  get roomState(): CanvasRoomState {
    return this.state;
  }

  get diagnostics(): string | null {
    return this.quarantineReason;
  }

  get currentRevision(): number {
    return this.revision;
  }

  get currentStorageSeq(): number {
    return this.storageSeq;
  }

  get roomEpoch(): string | null {
    return this.epoch;
  }

  /** 只读导出 published 的规范聚合。quarantine 或导出失败时返回 null。 */
  /**
   * 当前画布标题（published 文档的 `meta.title`；没有或类型不对时为空串）。
   *
   * 上游会话用它向服务端声明展示名：服务端从不解析 Yjs，管理端要展示可读名称只能靠
   * 客户端在 Hello 里带上。读 published 而不是 authoring：只有已持久化的内容才算数。
   * 这里不走 `exportCanvas()`——那会序列化整份文档，只为读一个字符串太贵。
   */
  title(): string {
    const value = this.published.getMap(YJS_SHARED_TYPES.meta).get("title");
    return typeof value === "string" ? value : "";
  }

  exportCanvas(): { ok: true; canvas: ServerCanvas } | { ok: false; code?: string; message: string } {
    if (this.state === "quarantined") {
      return {
        ok: false,
        ...(this.quarantineCode ? { code: this.quarantineCode } : {}),
        message: this.quarantineReason ?? "room 已隔离"
      };
    }
    const exported = yDocToServerCanvas(this.published, { now: this.now() });
    if (!exported.ok) return { ok: false, message: exported.failure.message };
    return { ok: true, canvas: exported.canvas };
  }

  /**
   * 加载/恢复 room（任务 4.5）。
   *
   * - 文档存在：正常恢复。
   * - 文档**不存在**（`not-found`）且注入了 `bootstrap`：用结构化存储的规范聚合建立
   *   首个 Y.Doc（新画布 bootstrap），成功后进入 `ready`。
   * - 文档存在但校验失败，或 `not-found` 且 bootstrap 也返回 `null`（结构化存储无该画布）：
   *   进入 `quarantined`，**不**创建空文档继续服务。
   */
  async load(): Promise<{ ok: true } | { ok: false; message: string }> {
    const recovered = await recoverYjsDocument({
      repository: this.repository,
      canvasId: this.canvasId,
      now: this.now()
    });
    if (recovered.ok) {
      this.published = recovered.doc;
      this.storageSeq = recovered.state.storageSeq;
      this.revision = recovered.revision;
      this.epoch = recovered.state.roomEpoch;
      this.state = "ready";
      return { ok: true };
    }

    // 仅「文档不存在」才尝试 seed / bootstrap；损坏（checksum/格式/结构）一律隔离。
    if (recovered.code === "not-found" && this.seedFromUpstream) {
      const seeded = await this.initializeFromUpstream();
      if (seeded) return { ok: true };
    }
    if (recovered.code === "not-found" && this.bootstrap) {
      let canvas: ServerCanvas | null = null;
      try {
        canvas = await this.bootstrap();
      } catch (error) {
        this.state = "quarantined";
        this.quarantineCode = "bootstrap-failed";
        this.quarantineReason = `bootstrap-failed: ${error instanceof Error ? error.message : String(error)}`;
        return { ok: false, message: this.quarantineReason };
      }
      if (canvas) {
        await this.initialize({
          canvas,
          roomEpoch: this.generateRoomEpoch(),
          createdAt: this.now()
        });
        return { ok: true };
      }
    }

    this.state = "quarantined";
    this.quarantineCode = recovered.code;
    this.quarantineReason = `${recovered.code}: ${recovered.message}`;
    return { ok: false, message: this.quarantineReason };
  }

  /** 用规范聚合初始化 room（为画布建立首个 Y.Doc）。 */
  async initialize(input: {
    canvas: ServerCanvas;
    roomEpoch: string;
    createdAt?: string;
  }): Promise<void> {
    const doc = serverCanvasToYDoc(input.canvas);
    await this.repository.createYjsDocument({
      canvasId: this.canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: input.roomEpoch,
      checkpoint: Y.encodeStateAsUpdate(doc),
      projection: input.canvas,
      revision: input.canvas.revision,
      createdAt: input.createdAt ?? this.now()
    });
    this.published = doc;
    this.storageSeq = 0;
    this.revision = input.canvas.revision;
    this.epoch = input.roomEpoch;
    this.state = "ready";
  }

  /**
   * room 当前的 Yjs state vector（用于 state-vector 驱动的初始同步）。
   *
   * 返回的是 Yjs 编码的 state vector（空文档为 `[0]`），可直接放进 sync step1 载荷。
   */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.published);
  }

  /**
   * 从 published 计算客户端缺失的差量。
   *
   * `stateVector` **必须**是 `Y.encodeStateVector` 的产物（空文档为 `[0]`）。
   * 传入 0 字节数组会被 Yjs 视为畸形输入并抛错，因此这里做规范化：0 字节等价于
   * 「客户端什么都没有」，用空 state vector 表达。
   */
  encodeDiff(stateVector: Uint8Array): Uint8Array {
    const normalized = stateVector.byteLength === 0
      ? Y.encodeStateVector(new Y.Doc())
      : stateVector;
    return Y.encodeStateAsUpdate(this.published, normalized);
  }

  /**
   * 查询一个 commandId 的 durable receipt（幂等预检，不产生副作用）。
   *
   * Agent authoring 服务用它区分「重试已成功请求」与「新的相同意图」：
   * identity 相同 + payload 相同 → 直接返回首次回执；payload 不同 → request-id-reused。
   */
  async lookupCommand(commandId: string): Promise<YjsCommandRecord | null> {
    if (commandId.trim() === "") return null;
    return this.repository.getCommandRecord(this.canvasId, commandId);
  }

  /**
   * 提交一个命令批次（任务 4.2–4.4）。
   *
   * 串行执行：并发调用按到达顺序排队，同 room 命令绝不交错。
   */
  submit(batch: CanvasCommandBatch, options?: RoomSubmitOptions): Promise<RoomCommandResult> {
    const run = this.queue.then(
      () => this.withStorageSeqRecovery(() => executeCommand(this.executionHost(), batch, options)),
      () => this.withStorageSeqRecovery(() => executeCommand(this.executionHost(), batch, options))
    );
    // 错误不应阻断队列：捕获后继续。
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read-only derivation in the authority queue; no request identity or receipt is recorded. */
  inspectPublished<T>(inspect: (snapshot: ReturnType<CanvasRoom["exportCanvas"]>) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(() => inspect(this.exportCanvas()), () => inspect(this.exportCanvas()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 串行「读改写」提交（change: add-model-camera-mcp-crud；
   *  change: 2026-10-13-add-canvas-script-authoring 扩展脚本提交身份/元数据）。
   *
   * 在 room 串行队列内：先按 `commandId` 查询 durable 回执（命中即返回 duplicate，保证
   * 传输层重试幂等，不重复应用变更），否则导出当前 published 聚合、交给调用方按**最新
   * 状态**派生命令批次，再走既有 `execute`。
   *
   * 脚本路径：`expectedPayloadHash` 区分「重试已成功请求」与「复用身份改内容」；
   * `script` 是源码无关的首次回执元数据，与画布 update 同事务持久化。
   */
  submitDerived(input: {
    commandId: string;
    /** 脚本请求 hash；提供时用于区分「重试已成功请求」与「复用身份改内容」。 */
    expectedPayloadHash?: string;
    expectedModelBatchHash?: string;
    /** T06: same operationId must carry the same frozen scene-area intent. */
    expectedWorldAuthoringHash?: string;
    expectedResourceEditHash?: string;
    derive: (canvas: ServerCanvas) =>
      | { ok: true; batch: CanvasCommandBatch; script?: CanvasScriptSubmissionMeta; modelBatch?: ModelScriptBatchMeta; resourceEdit?: import("@woohaa3/contracts").WorldResourceReceipt }
      | { ok: false; code: string; message: string }
      | Promise<
          | { ok: true; batch: CanvasCommandBatch; script?: CanvasScriptSubmissionMeta; modelBatch?: ModelScriptBatchMeta; resourceEdit?: import("@woohaa3/contracts").WorldResourceReceipt }
          | { ok: false; code: string; message: string }
        >;
  }, options?: RoomSubmitOptions): Promise<RoomCommandResult> {
    const run = this.queue.then(
      () => this.withStorageSeqRecovery(() => executeDerived(this.executionHost(), input, options)),
      () => this.withStorageSeqRecovery(() => executeDerived(this.executionHost(), input, options))
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 合入远端同步上游的 Yjs update（其它写入者已在各自 room 校验过的命令结果）。
   *
   * 与命令共用串行队列，并保持同一不变式：候选文档必须能导出合法规范聚合，持久化成功后
   * published 才前进并广播。update 对 published 没有净变化时不写存储、不广播。
   */
  applyExternalUpdate(update: Uint8Array): Promise<ExternalUpdateResult> {
    const run = this.queue.then(
      () => this.withStorageSeqRecovery(() => this.mergeExternal(update)),
      () => this.withStorageSeqRecovery(() => this.mergeExternal(update))
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 压缩 checkpoint（任务 3.6 的 room 侧入口）。
   *
   * cutoff 固定为**当前 storageSeq**：只压缩已持久化、且此刻不再有更新的部分。
   * 刻意不接受调用方指定 cutoff，避免误删尚未被 checkpoint 覆盖的 update。
   */
  async compact(): Promise<{ ok: boolean; cutoffSeq?: number }> {
    if (this.state !== "ready") return { ok: false };
    const projection = this.exportCanvas();
    if (!projection.ok) return { ok: false };
    const result = await compactYjsCheckpoint({
      repository: this.repository,
      canvasId: this.canvasId,
      doc: this.published,
      projection,
      now: this.now()
    });
    if (result.ok) this.storageSeq = Math.max(this.storageSeq, result.cutoffSeq);
    return result.ok ? { ok: true, cutoffSeq: result.cutoffSeq } : { ok: false };
  }

  /**
   * 等待当前排队的命令全部完成。
   *
   * 命令是串行队列，`submit` 的返回值本身就是完成信号；但会话层是「收到消息即
   * 异步处理」，因此需要一个显式的汇合点：优雅关闭前等待、以及测试里等待
   * fire-and-forget 的命令落地。
   */
  async settle(): Promise<void> {
    // 队列不断被新命令替换；循环直到稳定（自旋上限防止死循环）。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = this.queue;
      await snapshot.catch(() => undefined);
      if (snapshot === this.queue) return;
    }
  }

  /** 释放 room（清空内存文档；不影响持久化状态）。 */
  dispose(): void {
    this.published = new Y.Doc();
    this.state = "loading";
  }

  /**
   * 构造命令管线所需的受控 context。owner 仍是本实例：doc/revision 只在这里前进，
   * `finalizeAccepted` 唯一负责 durable 后的 published 前进、observer 顺序与广播。
   */
  private executionHost(): RoomExecutionHost {
    const self = this;
    return {
      canvasId: this.canvasId,
      get state() {
        return self.state;
      },
      get quarantineReason() {
        return self.quarantineReason;
      },
      repository: this.repository,
      mediaStorage: this.mediaStorage,
      verifyAssets: this.verifyAssets,
      content: this.content,
      lifecycle: this.lifecycle,
      get storageSeq() {
        return self.storageSeq;
      },
      get publishedDoc() {
        return self.published;
      },
      nowIso: () => self.now(),
      exportCanvas: () => self.exportCanvas(),
      finalizeAccepted: (input) => self.finalizeAccepted(input)
    };
  }

  private finalizeAccepted(input: {
    storageSeq: number;
    update: Uint8Array | null;
    revision: number;
    canvas: ServerCanvas;
    commands: readonly unknown[];
  }): void {
    this.storageSeq = input.storageSeq;
    if (input.update) {
      const before = this.onDelta ? this.exportCanvas() : null;
      Y.applyUpdate(this.published, input.update);
      this.revision = input.revision;
      // 编辑历史观察者：命令已 durable，先留档再广播（失败不影响命令结果）。
      this.onCommitted?.({ canvas: input.canvas, commands: input.commands });
      if (this.onDelta && before?.ok) this.onDelta({ before: before.canvas, after: input.canvas });
      this.broadcast?.({ room: this, update: input.update, revision: input.revision, origin: "command" });
    }
  }

  /**
   * 存储 sequence 冲突的自动恢复（change: 2026-10-29-recover-storage-seq-conflict）。
   *
   * 冲突的语义是「持久层已经被别的 writer（另一个宿主 / 另一个 room / 运维写入）推进」，
   * 本 room 内存里的 published 与 storageSeq 都可能落后。以前这里只把冲突返回给调用方，
   * 而 `storageSeq` 只有**提交成功**才会前进，于是同一个 room 之后每条命令都拿过期 seq
   * 去 CAS，客户端看到的「请重试」永远不可能成功。
   *
   * 现在的处理：从仓储重新恢复文档（拿到对方的内容与最新 seq），把本 room 缺失的部分广播给
   * 已连接客户端（origin=`upstream`，不回推中继），再用**同一批次**重试。批次命令与 update
   * 都幂等，因此重试不会重复应用；重试次数有上限，持续竞争时如实返回冲突。
   */
  private async withStorageSeqRecovery<T extends { ok: true } | { ok: false; code: string }>(
    run: () => Promise<T>
  ): Promise<T> {
    let result = await run();
    for (let attempt = 1; attempt <= MAX_STORAGE_SEQ_RECOVERIES; attempt += 1) {
      if (result.ok || result.code !== "storage-seq-conflict") return result;
      const recovered = await this.reloadFromStorage();
      this.onStorageSeqRecovered?.({ canvasId: this.canvasId, attempt, recovered });
      if (!recovered) return result;
      result = await run();
    }
    return result;
  }

  /**
   * 从存储重新恢复 published（冲突恢复用）。
   *
   * 与 `load()` 的区别：只接受「文档存在且校验通过」这一条路径——冲突时文档一定存在，
   * 走到 not-found 说明画布已被删除，不能再用 bootstrap/seed 重建；恢复失败即隔离 room。
   * 成功时把相对旧 published 的缺失内容广播出去（客户端可能也错过了对方那一版）。
   */
  private async reloadFromStorage(): Promise<boolean> {
    let recovered: Awaited<ReturnType<typeof recoverYjsDocument>>;
    try {
      recovered = await recoverYjsDocument({
        repository: this.repository,
        canvasId: this.canvasId,
        now: this.now()
      });
    } catch {
      // 存储暂时不可用：保留当前 published，把冲突如实返回。
      return false;
    }
    if (!recovered.ok) {
      this.state = "quarantined";
      this.quarantineCode = recovered.code;
      this.quarantineReason = `${recovered.code}: ${recovered.message}`;
      return false;
    }

    const known = Y.encodeStateVector(this.published);
    // 旧 published 已知的部分不重发；客户端已经收到过本 room 自己的 update。
    const missing = Y.encodeStateAsUpdate(recovered.doc, known);
    this.published = recovered.doc;
    this.storageSeq = recovered.state.storageSeq;
    this.revision = recovered.revision;
    this.epoch = recovered.state.roomEpoch;
    this.state = "ready";
    this.quarantineCode = null;
    this.quarantineReason = null;
    // 空 update 的编码是 2 字节（`[0, 0]`），不要为没有内容差别的情况制造广播。
    if (missing.byteLength > 2) {
      this.broadcast?.({ room: this, update: missing, revision: this.revision, origin: "upstream" });
    }
    return true;
  }

  /** 用上游完整状态建立本地首个 Y.Doc；上游为空、不可达或状态非法时返回 false。 */
  private async initializeFromUpstream(): Promise<boolean> {
    let state: Uint8Array | null;
    try {
      state = await this.seedFromUpstream!();
    } catch {
      return false;
    }
    if (!state) return false;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
    } catch {
      return false;
    }
    const exported = yDocToServerCanvas(doc, { now: this.now() });
    if (!exported.ok) return false;
    const roomEpoch = this.generateRoomEpoch();
    // 先补结构化目录行：远端拉下来的画布必须能出现在"我的画布"里，后续命令提交
    // 也要能找到画布行（两张表是独立的，只建 Yjs 文档不够）。
    await this.repository.ensureCanvasRow?.(exported.canvas);
    await this.repository.createYjsDocument({
      canvasId: this.canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch,
      checkpoint: Y.encodeStateAsUpdate(doc),
      projection: exported.canvas,
      revision: exported.canvas.revision,
      createdAt: this.now()
    });
    this.published = doc;
    this.storageSeq = 0;
    this.revision = exported.canvas.revision;
    this.epoch = roomEpoch;
    this.state = "ready";
    return true;
  }

  private async mergeExternal(update: Uint8Array): Promise<ExternalUpdateResult> {
    if (this.state !== "ready") {
      return this.state === "quarantined"
        ? { ok: false, code: "room-quarantined", message: this.quarantineReason ?? "room 已隔离" }
        : { ok: false, code: "room-not-ready", message: "room 尚未加载完成" };
    }
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.published));
    // 只有真正改变文档的部分才会触发 update 事件；据此得到相对 published 的净 update。
    const effective: Uint8Array[] = [];
    candidate.on("update", (change: Uint8Array) => effective.push(change));
    try {
      Y.applyUpdate(candidate, update);
    } catch (error) {
      return { ok: false, code: "malformed-update", message: error instanceof Error ? error.message : String(error) };
    }
    if (effective.length === 0) return { ok: true, changed: false, revision: this.revision };
    const netUpdate = effective.length === 1 ? effective[0]! : Y.mergeUpdates(effective);

    const exported = yDocToServerCanvas(candidate, { now: this.now() });
    if (!exported.ok) {
      return { ok: false, code: "invalid-document", message: exported.failure.message };
    }
    const canvas = exported.canvas;
    const hash = await computeUpdateSha256(netUpdate);
    const commit = await this.repository.commitYjsCommand({
      canvasId: this.canvasId,
      expectedStorageSeq: this.storageSeq,
      update: netUpdate,
      revision: canvas.revision,
      updatedAt: canvas.updatedAt,
      projection: canvas,
      command: {
        commandId: `upstream:${hash}`,
        payloadHash: hash,
        revision: canvas.revision,
        changed: true,
        actorId: UPSTREAM_ACTOR_ID,
        createdAt: this.now()
      }
    }).catch((error: unknown) => ({
      ok: false as const,
      code: "storage-failed" as const,
      message: error instanceof Error ? error.message : String(error)
    }));
    if (!commit.ok) {
      return { ok: false, code: commit.code, message: "message" in commit ? commit.message : commit.code };
    }

    this.storageSeq = commit.storageSeq;
    Y.applyUpdate(this.published, netUpdate);
    this.revision = canvas.revision;
    this.broadcast?.({ room: this, update: netUpdate, revision: canvas.revision, origin: "upstream" });
    return { ok: true, changed: true, revision: canvas.revision };
  }
}
