/**
 * 服务端命令 transaction 引擎（任务 2.3–2.5 / design D2、D6）。
 *
 * 这是「语义命令 → 权威 Y.Doc」的核心：把前置 change 的**纯命令 reducer** 与
 * **MediaStorage 校验**复用到 Yjs 路径上，保证两条路径（remote-CAS 与 Yjs）对同一命令
 * 生成**等价**的 ServerCanvas（task 2.3）。
 *
 * 流程（design D6）：
 * 1. 从 published 导出 ServerCanvas；
 * 2. 调用 `applyCanvasCommands`（前置的纯 reducer）形成 next aggregate；
 * 3. 校验新增资产的 COS 引用（复用 `validateAssetReferences`）；
 * 4. 在 authoring Y.Doc 单 transaction 内写净差异 + revision/updatedAt，捕获 update；
 * 5. 由调用方持久化后 apply 到 published 并广播。
 *
 * 本模块**不做持久化**：它是纯计算 + 幂等记录，持久化与广播由 room 负责（depend 注入）。
 */
import * as Y from "yjs";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import { applyCanvasCommands, collectMutatedAssets, validateAssetReferences } from "../storage/core/index.js";
import { applyCanvasDiffToYDoc, writeRevisionMeta } from "@woohaa3/contracts/canvas-yjs";
import { yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

export type CommandTransactionOutcome =
  | {
      ok: true;
      /** 是否为 no-op（有效命令但无净变化）。no-op 不产生业务 update、不推进 revision。 */
      changed: boolean;
      /** 事务后的业务 revision；no-op 时等于 base revision。 */
      revision: number;
      updatedAt: string;
      /** 若 changed，这是产生的 Yjs update（供持久化与广播）。 */
      update: Uint8Array | null;
      /** 事务后的完整聚合（changed 时是新状态，no-op 时是原状态）。 */
      canvas: ServerCanvas;
    }
  | {
      ok: false;
      /** 领域拒绝 / 资产引用非法 / 损坏状态。 */
      code: string;
      message: string;
    };

export type ApplyCommandTransactionOptions = {
  content?: import("@woohaa3/contracts").ContentContributionResolver;
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  /** 权威 authoring Y.Doc（应为 published 的可写副本）。 */
  doc: Y.Doc;
  batch: CanvasCommandBatch;
  mediaStorage?: MediaStorage;
  now: string;
  /** 资产引用校验开关；运维/离线导入可关闭，运行时必须开启。 */
  verifyAssets?: boolean;
};

/**
 * 在 authoring Y.Doc 上执行一个命令批次。
 *
 * **原子性**：整批命令在一个 Yjs transaction 内形成；后续命令失败时整个 transaction
 * 的结果被丢弃（调用方不写回 authoring doc），因此不产生部分 update。
 *
 * 注意：这里对传入的 `doc` 是**原地修改**。调用方应先 clone（或使用 authoring/published
 * 双文档模型）：失败时丢弃 authoring，成功时才把捕获的 update 应用到 published。
 */
export async function applyCommandTransaction(
  options: ApplyCommandTransactionOptions
): Promise<CommandTransactionOutcome> {
  const { doc, batch, now } = options;

  // 1) 从当前 Y.Doc 导出规范聚合。
  const exported = yDocToServerCanvas(doc, { now });
  if (!exported.ok) {
    return { ok: false, code: "canvas-corrupt", message: exported.failure.message };
  }
  const current = exported.canvas;

  // 2) 复用前置 change 的纯 reducer：Yjs 路径与 remote-CAS 路径共享同一命令语义。
  const applied = applyCanvasCommands(current, batch.commands, { now, lifecycle: options.lifecycle, content: options.content });
  if (!applied.ok) {
    return {
      ok: false,
      code: applied.rejection.code,
      message: applied.rejection.message
    };
  }

  // 无净变化：记录可幂等返回的结果，但不写 update、不推进 revision。
  if (!applied.changed) {
    return {
      ok: true,
      changed: false,
      revision: current.revision,
      updatedAt: current.updatedAt,
      update: null,
      canvas: current
    };
  }

  // 3) 只校验新增/变更资产的 COS 引用（复用前置能力，避免每次提交访问全部历史对象）。
  if (options.verifyAssets !== false) {
    const mutated = collectMutatedAssets(current.assets, applied.canvas.assets);
    try {
      await validateAssetReferences(mutated, {
        mediaStorage: options.mediaStorage,
        // Yjs 路径同样知道画布：让远端画布在它路由到的后端核验资产。
        scope: { canvasId: current.id },
        now
      });
    } catch (error) {
      return {
        ok: false,
        code: "asset-reference-invalid",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // 4) 在单 transaction 内写净差异 + revision，并捕获产生的 update。
  const nextRevision = current.revision + 1;
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    applyCanvasDiffToYDoc(doc, current, applied.canvas);
    writeRevisionMeta(doc, nextRevision, applied.canvas.updatedAt);
  });
  const update = Y.encodeStateAsUpdate(doc, before);

  return {
    ok: true,
    changed: true,
    revision: nextRevision,
    updatedAt: applied.canvas.updatedAt,
    update,
    canvas: { ...applied.canvas, revision: nextRevision }
  };
}

/**
 * 命令幂等记录（task 2.5 / design D6）。
 *
 * 语义：
 * - 相同 `commandId` + 相同 payload hash → 返回**首次**结果，不重复应用；
 * - 相同 `commandId` + 不同 payload → 稳定拒绝（`command-id-reused`）；
 * - 不同 `commandId` → 正常应用。
 *
 * 这是一个纯内存实现，便于测试与单实例 room 使用；持久化版本由 repository 提供
 * （必须在与 update 相同的事务内写入）。
 */
export type CommandReceipt = {
  commandId: string;
  payloadHash: string;
  revision: number;
  changed: boolean;
  updatedAt: string;
};

export type CommandReceiptLookup =
  | { status: "new" }
  | { status: "duplicate"; receipt: CommandReceipt }
  | { status: "reused"; existingHash: string };

export class CommandReceiptRegistry {
  private readonly receipts = new Map<string, CommandReceipt>();

  /** 在应用命令**之前**查询，以便重复命令直接返回首次结果。 */
  lookup(commandId: string, payloadHash: string): CommandReceiptLookup {
    const existing = this.receipts.get(commandId);
    if (!existing) return { status: "new" };
    if (existing.payloadHash !== payloadHash) {
      return { status: "reused", existingHash: existing.payloadHash };
    }
    return { status: "duplicate", receipt: existing };
  }

  /** 应用成功后登记结果。 */
  record(receipt: CommandReceipt): void {
    this.receipts.set(receipt.commandId, receipt);
  }

  get(commandId: string): CommandReceipt | undefined {
    return this.receipts.get(commandId);
  }

  get size(): number {
    return this.receipts.size;
  }
}
