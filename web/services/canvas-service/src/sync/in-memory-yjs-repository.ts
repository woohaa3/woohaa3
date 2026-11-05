/**
 * 测试用 in-memory `YjsDocumentRepository`（任务 3.1）。
 *
 * 实现与 SQLite/Mongo 相同的契约语义（CAS、幂等、原子提交、checkpoint 压缩保留 cutoff 后
 * update），因此可被 adapter contract suite 直接复用，先固定行为再验证真实数据库不漂移。
 *
 * 刻意只用于测试：生产路径由 composition root 显式选择 SQLite 或 Mongo。
 */
import type { YjsArchiveSnapshot } from "./archive-publication.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeUpdateSha256,
  type YjsCommandCommit,
  type YjsCommandRecord,
  type YjsCommitResult,
  type YjsDocumentRepository,
  type YjsLoadedState,
  type YjsRepositoryHealth } from "./yjs-repository.js";

type StoredDocument = {
  canvasId: string;
  formatVersion: string;
  roomEpoch: string | null;
  checkpoint: Uint8Array;
  checkpointSeq: number;
  updates: Array<{ seq: number; update: Uint8Array; sha256: string }>;
  storageSeq: number;
  projection: ServerCanvas | null;
  commands: Map<string, YjsCommandRecord>;
  createdAt: string;
  updatedAt: string;
};

export type InMemoryYjsFaults = {
  failNextCommit?: Error;
  failNextCreate?: Error;
};

export class InMemoryYjsDocumentRepository implements YjsDocumentRepository {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly faults: InMemoryYjsFaults;

  constructor(options: { faults?: InMemoryYjsFaults } = {}) {
    this.faults = options.faults ?? {};
  }

  /** 测试用：注入下一次提交失败，验证全回滚。 */
  failNextCommit(error: Error): void {
    this.faults.failNextCommit = error;
  }

  async loadYjsState(canvasId: string): Promise<YjsLoadedState | null> {
    const doc = this.documents.get(canvasId);
    if (!doc) return null;
    return {
      canvasId: doc.canvasId,
      formatVersion: doc.formatVersion,
      roomEpoch: doc.roomEpoch,
      checkpoint: doc.checkpoint.slice(),
      checkpointSeq: doc.checkpointSeq,
      updates: doc.updates.map((entry) => ({ ...entry, update: entry.update.slice() })),
      storageSeq: doc.storageSeq,
      projection: doc.projection ? structuredClone(doc.projection) : null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  async commitYjsCommand(commit: YjsCommandCommit): Promise<YjsCommitResult> {
    const doc = this.documents.get(commit.canvasId);
    if (!doc) {
      // 文档不存在是调用方的编排错误；按存储冲突语义返回，避免静默成功。
      return { ok: false, code: "storage-seq-conflict", currentSeq: -1 };
    }

    // 幂等优先：相同 commandId 先查记录（在 seq 校验之前）。
    const existing = doc.commands.get(commit.command.commandId);
    if (existing) {
      if (existing.payloadHash !== commit.command.payloadHash) {
        return { ok: false, code: "command-id-reused", existingHash: existing.payloadHash };
      }
      return { ok: true, storageSeq: doc.storageSeq, revision: existing.revision, duplicate: true };
    }

    if (doc.storageSeq !== commit.expectedStorageSeq) {
      return { ok: false, code: "storage-seq-conflict", currentSeq: doc.storageSeq };
    }

    const fault = this.faults.failNextCommit;
    if (fault) {
      this.faults.failNextCommit = undefined;
      throw fault;
    }

    const sha256 = await computeUpdateSha256(commit.update);
    if (commit.signal?.aborted) throw new DOMException("Commit cancelled", "AbortError");
    // 全部校验通过后一次性写入（模拟单事务）。
    const nextSeq = doc.storageSeq + 1;
    doc.updates.push({
      seq: nextSeq,
      update: commit.update.slice(),
      sha256
    });
    doc.storageSeq = nextSeq;
    doc.projection = structuredClone(commit.projection);
    doc.commands.set(commit.command.commandId, { ...commit.command });
    doc.updatedAt = commit.updatedAt;

    return { ok: true, storageSeq: nextSeq, revision: commit.revision, duplicate: false };
  }

  async getCommandRecord(canvasId: string, commandId: string): Promise<YjsCommandRecord | null> {
    return this.documents.get(canvasId)?.commands.get(commandId) ?? null;
  }

  async replaceCheckpoint(input: {
    canvasId: string;
    cutoffSeq: number;
    checkpoint: Uint8Array;
    updatedAt: string;
  }): Promise<void> {
    const doc = this.documents.get(input.canvasId);
    if (!doc) return;
    doc.checkpoint = input.checkpoint.slice();
    doc.checkpointSeq = input.cutoffSeq;
    // 只删除被 checkpoint 覆盖的 updates；cutoff 之后的必须保留（design D8）。
    doc.updates = doc.updates.filter((entry) => entry.seq > input.cutoffSeq);
    doc.updatedAt = input.updatedAt;
  }

  async createYjsDocument(input: {
    canvasId: string;
    formatVersion: string;
    roomEpoch: string;
    checkpoint: Uint8Array;
    projection: ServerCanvas;
    revision: number;
    createdAt: string;
  }): Promise<void> {
    const fault = this.faults.failNextCreate;
    if (fault) {
      this.faults.failNextCreate = undefined;
      throw fault;
    }
    this.documents.set(input.canvasId, {
      canvasId: input.canvasId,
      formatVersion: input.formatVersion,
      roomEpoch: input.roomEpoch,
      checkpoint: input.checkpoint.slice(),
      checkpointSeq: 0,
      updates: [],
      storageSeq: 0,
      projection: structuredClone(input.projection),
      commands: new Map(),
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    });
  }

  async deleteYjsDocument(canvasId: string): Promise<void> {
    this.documents.delete(canvasId);
  }

  async captureArchiveState(canvasId: string): Promise<YjsArchiveSnapshot | null> {
    const state = await this.loadYjsState(canvasId);
    if (!state) return null;
    return { state, revision: state.projection?.revision ?? 0,
      commands: structuredClone([...this.documents.get(canvasId)!.commands.values()]) };
  }

  async replaceArchiveState(canvasId: string, snapshot: YjsArchiveSnapshot | null): Promise<void> {
    if (!snapshot) { this.documents.delete(canvasId); return; }
    this.documents.set(canvasId, { ...structuredClone(snapshot.state),
      commands: new Map(snapshot.commands.map(command => [command.commandId, structuredClone(command)])) });
  }

  async health(): Promise<YjsRepositoryHealth> {
    return { ok: true, backend: "memory" };
  }

  /** 测试用：当前存储 sequence。 */
  storageSeq(canvasId: string): number {
    return this.documents.get(canvasId)?.storageSeq ?? -1;
  }

  /** 测试用：命令记录数量（验证压缩不删除幂等记录）。 */
  commandCount(canvasId: string): number {
    return this.documents.get(canvasId)?.commands.size ?? 0;
  }

  /** 测试用：update 条数。 */
  updateCount(canvasId: string): number {
    return this.documents.get(canvasId)?.updates.length ?? 0;
  }
}
