/**
 * 画布导入编排服务（prepare/status/list + 原子导入）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.2、4.7–4.10 / design D6、D9、D10、D12）。
 *
 * 状态机：`resolveAccessible`（受认证，含来源 ACL）→ `prepareCandidate`（扩展转换 + 媒体）→
 * 目标独立验证 → 同连接原子提交 → **提交成功后**发布 room。
 *
 * 幂等/恢复：每个来源画布一个持久作业；`createJob` 幂等，`beginAttempt` 推进 fence 使旧
 * attempt 提交失效；重启时 `recoverInterruptedJobs` 把 running 降回 pending。同一画布在
 * 进程内串行（`inFlight`），避免并行提交。
 */
import { createHash } from "node:crypto";
import {
  type CanvasImportErrorCode,
  type CanvasImportCandidate,
  type CanvasSourceBinding,
  type ImportedCanvasAccess,
  type PreparationPhase,
  type PreparationState,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { SqliteCanvasImportStore } from "../storage/sqlite/canvas-import.js";
import { validateImportCandidate } from "./candidate-validation.js";
import type { CanvasSourceAccessHandle, CanvasSourcePort } from "./contracts.js";
import { canReadImported, canWriteImported } from "./access.js";

export type CanvasImportServiceOptions = {
  sources: CanvasSourcePort;
  store: SqliteCanvasImportStore;
  mediaStorage: MediaStorage;
  /** 提交成功后调用（销毁/失效旧 room）；返回值忽略，失败只记录。 */
  onCommitted?: (input: { canvasId: string; candidate: CanvasImportCandidate }) => Promise<void> | void;
  /** 删除导入目标后调用（销毁 room）；返回值忽略，失败只记录。 */
  onDeleted?: (input: { canvasId: string }) => Promise<void> | void;
  /** 生成新 room epoch（默认随机）。 */
  generateRoomEpoch?: () => string;
  /** 生成 jobId（默认确定性：同来源画布绑定的哈希）。 */
  generateJobId?: (binding: Pick<CanvasSourceBinding, "sourceId" | "sourceCanvasId" | "cutoverGeneration" | "configVersion" | "converterVersion">) => string;
  now?: () => string;
  logger?: (event: Record<string, unknown>) => void;
};

export type PrepareResult =
  | { ok: true; state: PreparationState }
  | { ok: false; status: number; code: CanvasImportErrorCode; message: string };

export type ImportServiceStatus =
  | { kind: "ready"; canvasId: string; revision: number }
  | { kind: "preparing"; jobId: string; phase: string; completedMedia: number; totalMedia: number }
  | { kind: "failed"; code: string; retryable: boolean; message: string }
  | { kind: "deleted"; code: "DELETED" };

export class CanvasImportService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: CanvasImportServiceOptions) {}

  /**
   * 幂等触发准备：已 ready 返回 ready；已有活动作业复用；否则创建作业并后台推进。
   *
   * 返回时作业已持久化；实际导入在后台进行（progress 由 status 轮询看到）。
   */
  async prepare(input: {
    subject: string;
    sourceCanvasId: string;
    sourceId?: string;
    /** 已解析的访问 handle（list 场景复用，避免重复解析）；省略时由服务解析。 */
    handle?: CanvasSourceAccessHandle;
  }): Promise<PrepareResult> {
    const receiptState = this.options.store.getReceiptState(input.sourceCanvasId);
    if (receiptState === "deleted") {
      return { ok: false, status: 410, code: "DELETED", message: "已删除的作品不自动重建" };
    }
    if (receiptState === "ready" && !this.options.store.hasCanvas(input.sourceCanvasId)) {
      // ready receipt 但目标缺失 = 目标故障；不回源覆盖（spec canvas-persistence）。
      return { ok: false, status: 409, code: "TARGET_CONFLICT", message: "目标记录缺失，拒绝回源覆盖" };
    }
    if (this.options.store.hasCanvas(input.sourceCanvasId)) {
      return { ok: true, state: { state: "ready", canvasId: input.sourceCanvasId, revision: 1 } };
    }

    const handle = input.handle ?? await this.resolveHandle(input.subject, input.sourceCanvasId, input.sourceId);
    if ("ok" in handle && handle.ok === false) {
      return { ok: false, status: statusForCode(handle.code), code: handle.code, message: handle.message };
    }
    const access = handle as CanvasSourceAccessHandle;

    const targetId = access.targetCanvasId;
    const targetReceiptState = this.options.store.getReceiptState(targetId);
    if (targetReceiptState === "deleted") {
      return { ok: false, status: 410, code: "DELETED", message: "已删除的作品不自动重建" };
    }
    if (this.options.store.hasCanvas(targetId)) {
      this.options.store.supersedeOtherActiveJobs(access.binding.sourceId, access.binding.sourceCanvasId, "");
      return { ok: true, state: { state: "ready", canvasId: targetId, revision: 1 } };
    }
    const active = this.options.store.findActiveJob(access.binding.sourceId, access.binding.sourceCanvasId);
    if (active) {
      return {
        ok: true,
        state: {
          state: "preparing",
          jobId: active.jobId,
          phase: active.phase as PreparationPhase,
          completedMedia: active.completedMedia,
          totalMedia: active.totalMedia,
          pollAfterMs: 1_500
        }
      };
    }
    const jobDef = { ...access.binding, sourceVersion: access.sourceVersion };
    const jobId = (this.options.generateJobId ?? defaultJobId)(jobDef);
    this.options.store.createJob({
      jobId,
      targetCanvasId: targetId,
      binding: jobDef,
      subject: input.subject,
      totalMedia: 0
    });
    // 配置版本/转换器版本换代：同来源同画布的旧活动作业进入 draining（被取代）。
    this.options.store.supersedeOtherActiveJobs(access.binding.sourceId, access.binding.sourceCanvasId, jobId);

    this.ensureRunning(jobId, input.subject, access);
    return {
      ok: true,
      state: { state: "preparing", jobId, phase: "admitted", completedMedia: 0, totalMedia: 0, pollAfterMs: 1_500 }
    };
  }

  /** 无创建副作用的状态查询。 */
  status(sourceCanvasId: string): ImportServiceStatus {
    const receiptState = this.options.store.getReceiptState(sourceCanvasId);
    if (receiptState === "deleted") return { kind: "deleted", code: "DELETED" };
    if (this.options.store.hasCanvas(sourceCanvasId)) {
      return { kind: "ready", canvasId: sourceCanvasId, revision: 1 };
    }
    const job = this.options.store.findActiveJobByCanvas(sourceCanvasId) ?? this.options.store.latestJobByCanvas(sourceCanvasId);
    if (job) {
      if (job.state === "failed" || job.state === "superseded") {
        return {
          kind: "failed",
          code: job.errorCode ?? "SOURCE_UNAVAILABLE",
          retryable: job.state === "superseded" ? true : job.errorRetryable ?? true,
          message: job.errorMessage ?? "导入失败"
        };
      }
      if (job.state === "pending" || job.state === "running") {
        return { kind: "preparing", jobId: job.jobId, phase: job.phase, completedMedia: job.completedMedia, totalMedia: job.totalMedia };
      }
    }
    return { kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true, message: "尚未准备" };
  }

  /** 重启恢复：running → pending，并重新推进（不自动重放 media 之外的副作用）。 */
  recover(): number {
    return this.options.store.recoverInterruptedJobs();
  }

  /** 列出来源目录（合并本进程的收据状态）。 */
  async listAccessible(input: { subject: string; sourceId: string; cursor: string | null; limit: number }) {
    const page = await this.options.sources.listAccessible(input);
    return {
      items: page.items.map((item) => {
        const receiptState = this.options.store.getReceiptState(item.targetCanvasId);
        const active = this.options.store.findActiveJob(item.ref.sourceId, item.ref.sourceCanvasId);
        const availability = receiptState === "deleted"
          ? "not-prepared"
          : this.options.store.hasCanvas(item.targetCanvasId)
            ? "ready"
            : active
              ? "preparing"
              : "not-prepared";
        return { ...item, availability } as typeof item;
      }),
      nextCursor: page.nextCursor
    };
  }

  /** 活动来源目录（透传窄端口，不含路径/URI）。 */
  async listSources() {
    return this.options.sources.listSources();
  }

  /** 目标 ACL 授权（供 Canvas authorizer 预热）：导入画布按标准化 ACL 判定。 */
  authorize(input: { canvasId: string; subject: string; permission: "read" | "write" }): boolean | null {
    const stored = this.options.store.getImportedAccess(input.canvasId);
    if (!stored) return null;
    return input.permission === "read"
      ? canReadImported(stored.access, input.subject)
      : canWriteImported(stored.access, input.subject);
  }

  /** 导入目标中该主体可读的 canvasId（任务 5.9：与「我的目录」合并发现集合）。 */
  listReadableCanvasIds(subject: string): string[] {
    const trimmed = subject.trim();
    if (trimmed === "") return [];
    return this.options.store
      .listImportedAccess()
      .filter((entry) => canReadImported(entry.access, trimmed))
      .map((entry) => entry.canvasId);
  }

  /** 迁移态访问门：供 Canvas API 判定 PREPARATION_REQUIRED / DELETED / 导入删除。 */
  guardState(canvasId: string): { kind: "none" } | { kind: "deleted" } | { kind: "preparing"; jobId: string } | { kind: "ready" } {
    const receiptState = this.options.store.getReceiptState(canvasId);
    if (receiptState === "deleted") return { kind: "deleted" };
    if (this.options.store.hasCanvas(canvasId)) return { kind: "ready" };
    const active = this.options.store.findActiveJobByCanvas(canvasId);
    if (active) return { kind: "preparing", jobId: active.jobId };
    return { kind: "none" };
  }

  /**
   * 删除导入目标：同事务写持久 deleted tombstone，清理 canonical/Yjs/ACL/历史/诊断。
   * 来源绑定保留；删除后 `status`/`prepare` 返回 DELETED，不自动复活。
   */
  deleteImported(canvasId: string): void {
    this.options.store.deleteImportedCanvas(canvasId);
    void this.options.onDeleted?.({ canvasId });
  }

  private async resolveHandle(
    subject: string,
    sourceCanvasId: string,
    sourceId?: string
  ): Promise<CanvasSourceAccessHandle | { ok: false; code: CanvasImportErrorCode; message: string }> {
    try {
      const result = await this.options.sources.resolveAccessible({ subject, sourceCanvasId, ...(sourceId ? { sourceId } : {}) });
      return result.ok ? result.handle : { ok: false, code: result.code, message: result.message };
    } catch {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源暂时不可用" };
    }
  }

  private ensureRunning(jobId: string, subject: string, access: CanvasSourceAccessHandle): void {
    if (this.inFlight.has(jobId)) return;
    const run = this.runImport(jobId, subject, access)
      .catch((error) => {
        this.options.logger?.({ event: "canvas-import-unexpected", jobId, message: String(error) });
      })
      .finally(() => {
        this.inFlight.delete(jobId);
      });
    this.inFlight.set(jobId, run);
  }

  private async runImport(jobId: string, subject: string, access: CanvasSourceAccessHandle): Promise<void> {
    const store = this.options.store;
    store.beginAttempt(jobId, "reading");
    store.updateProgress(jobId, { phase: "reading", completedMedia: 0, totalMedia: 0 });
    const binding: CanvasSourceBinding = { ...access.binding, sourceVersion: access.sourceVersion };

    const candidateResult = await this.options.sources.prepareCandidate({ subject, handle: access });
    if (!candidateResult.ok) {
      store.markFailed(jobId, { code: candidateResult.code, retryable: candidateResult.retryable, message: candidateResult.message });
      return;
    }
    const candidate = candidateResult.candidate;
    store.updateProgress(jobId, { phase: "converting", completedMedia: 0, totalMedia: candidate.canvas.assets.length });

    const validated = await validateImportCandidate({ candidate: candidate.canvas, mediaStorage: this.options.mediaStorage, now: this.options.now?.() ?? new Date().toISOString() });
    if (!validated.ok) {
      store.markFailed(jobId, { code: validated.code, retryable: validated.retryable, message: validated.message });
      return;
    }
    store.updateProgress(jobId, { phase: "validating", completedMedia: validated.canvas.assets.length, totalMedia: validated.canvas.assets.length });

    // 提交前再验来源冻结/水位/权限版本。
    const revalidate = await this.options.sources.validateSnapshot({ subject, binding });
    if (!revalidate.ok) {
      store.markFailed(jobId, { code: revalidate.code, retryable: revalidate.retryable, message: revalidate.message });
      return;
    }

    // 用**当前** Yjs codec 构建新 epoch 的 checkpoint（不复制旧 update）。
    const { serverCanvasToYDoc } = await import("@woohaa3/contracts/canvas-yjs");
    const doc = serverCanvasToYDoc(validated.canvas);
    let checkpoint: Uint8Array;
    try {
      checkpoint = (await import("yjs")).encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }

    store.updateProgress(jobId, { phase: "committing", completedMedia: validated.canvas.assets.length, totalMedia: validated.canvas.assets.length });
    const roomEpoch = (this.options.generateRoomEpoch ?? defaultRoomEpoch)();
    let receipt;
    try {
      receipt = store.commitImport({
        jobId,
        fence: store.getJob(jobId)!.fence,
        candidateCanvas: validated.canvas,
        checkpoint,
        roomEpoch,
        formatVersion: YJS_CANVAS_FORMAT_VERSION,
        access: candidate.access,
        historyJson: JSON.stringify(candidate.history),
        diagnostics: candidate.diagnostics.entries,
        diagSummary: {
          readyMediaCount: candidate.diagnostics.readyMediaCount,
          restoredHistoryCount: candidate.diagnostics.restoredHistoryCount,
          unrecoveredRecordCount: candidate.diagnostics.unrecoveredRecordCount
        },
        now: this.options.now?.() ?? new Date().toISOString()
      });
    } catch (error) {
      const code = errorCodeOf(error);
      store.markFailed(jobId, { code, retryable: code !== "TARGET_CONFLICT", message: "导入提交失败" });
      return;
    }

    // COMMIT 之后才发布 room；发布失败不回滚已提交的权威数据。
    try {
      await this.options.onCommitted?.({ canvasId: receipt.targetCanvasId, candidate });
    } catch (error) {
      this.options.logger?.({ event: "canvas-import-publish-failed", jobId, message: String(error) });
    }
  }

}

function statusForCode(code: CanvasImportErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED": return 401;
    case "FORBIDDEN": return 403;
    case "SOURCE_UNAVAILABLE": return 503;
    case "SOURCE_CHANGED": return 409;
    case "SOURCE_AMBIGUOUS": return 409;
    case "UNSUPPORTED_SOURCE_FORMAT": return 422;
    case "TARGET_CONFLICT": return 409;
    case "MEDIA_MISSING": return 409;
    case "CANDIDATE_INVALID": return 422;
    case "LIMIT_EXCEEDED": return 413;
    case "PREPARATION_REQUIRED": return 409;
    case "DELETED": return 410;
    default: return 500;
  }
}

function defaultJobId(binding: Pick<CanvasSourceBinding, "sourceId" | "sourceCanvasId" | "cutoverGeneration" | "configVersion" | "converterVersion">): string {
  const raw = `${binding.sourceId}\u0000${binding.sourceCanvasId}\u0000${binding.cutoverGeneration}\u0000${binding.configVersion}\u0000${binding.converterVersion}`;
  return `import-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function defaultRoomEpoch(): string {
  return `epoch-import-${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
}

function errorCodeOf(error: unknown): CanvasImportErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TARGET_CONFLICT") || message.includes("已存在")) return "TARGET_CONFLICT";
  if (message.includes("SOURCE_CHANGED") || message.includes("取代")) return "SOURCE_CHANGED";
  return "SOURCE_UNAVAILABLE";
}

export type { ServerCanvas, ImportedCanvasAccess };
