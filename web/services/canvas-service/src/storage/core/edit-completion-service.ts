/**
 * 图片/模型编辑完成应用服务公共入口
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 2.2–2.7 / design D5/D6；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R13 —— 拆分为
 *  helpers/outbox/image/model 子模块，本文件保留薄 facade 与生命周期协调）。
 *
 * 权威保存路径：
 * - **图片**：先持久化 `prepared` 回执；重读最新画布校验写权限、目标类型、媒体引用、active run
 *   与内容基线；以单个原子 batch 提交 base/output asset 与 imageEdit；成功后把固定基线与最终
 *   版本 snapshot 与回执一起写为 `history-pending`，再尝试登记历史。
 * - **模型**：complete 只归档最终快照，不额外推进 revision。
 */
import {
  editCompletePayloadFingerprint,
  type ImageProjectReferencesRequest,
  type EditSessionBeginRequest,
  type EditSessionCompleteRequest,
  type EditSessionErrorCode,
  type EditSessionStatusResponse
} from "@woohaa3/contracts";
import type { EditCompletionRepository } from "./edit-completion-contracts.js";
import { verifyProjectReferences } from "./edit-completion-service/references.js";
import { recoverPrepared } from "./edit-completion-service/recovery.js";
import { completeImage } from "./edit-completion-service/image-completion.js";
import { completeModel } from "./edit-completion-service/model-completion.js";
import { publishPending } from "./edit-completion-service/outbox.js";
import { currentIdentityOfNode, failWithReceipt, kindForNodeType, toReceipt } from "./edit-completion-service/helpers.js";
import type {
  EditCompletionContext,
  EditCompletionResult,
  EditCompletionServiceOptions,
  NodeHistoryEntryPublisher
} from "./edit-completion-service/types.js";

export type {
  EditCompletionServiceOptions,
  EditCompletionResult,
  NodeHistoryEntryPublisher
} from "./edit-completion-service/types.js";

export class EditCompletionService {
  private readonly completions: EditCompletionRepository;
  private readonly publisher: NodeHistoryEntryPublisher;
  private readonly resolveRoom: EditCompletionContext["resolveRoom"];
  // 核验要按画布作用域：远端画布的编辑产物可能只在托管存储里（scope 由 context 的
  // mediaVerifier 签名声明，这里不能把它窄掉）。
  private readonly mediaVerifier?: EditCompletionContext["mediaVerifier"];
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly clock: () => string;

  constructor(options: EditCompletionServiceOptions) {
    this.completions = options.completions;
    this.publisher = options.publisher;
    this.resolveRoom = options.resolveRoom;
    this.mediaVerifier = options.mediaVerifier;
    this.log = options.logger ?? (() => undefined);
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  private get ctx(): EditCompletionContext {
    return {
      completions: this.completions,
      publisher: this.publisher,
      resolveRoom: this.resolveRoom,
      ...(this.mediaVerifier ? { mediaVerifier: this.mediaVerifier } : {}),
      log: this.log,
      now: () => this.clock()
    };
  }

  private now(): string {
    return this.clock();
  }

  /** 是否具备可持久保存历史的能力（design D6）。 */
  capabilities(): { persistentHistory: boolean } {
    return { persistentHistory: true };
  }

  /** begin：捕获基线但不推进 revision（design D6）。 */
  async begin(request: EditSessionBeginRequest): Promise<
    | { ok: true; sessionId: string; baselineContentIdentity: string; revision: number }
    | { ok: false; code: EditSessionErrorCode; message: string }
  > {
    const room = await this.resolveRoom(request.canvasId);
    if (!room) return fail("EDIT_SESSION_TARGET_INVALID", `画布 ${request.canvasId} 不存在`);
    const exported = room.exportCanvas();
    if (!exported.ok) return fail("EDIT_SESSION_TARGET_INVALID", exported.message);
    const node = exported.canvas.document.nodes.find((candidate) => candidate.id === request.nodeId);
    if (!node) return fail("EDIT_SESSION_TARGET_INVALID", `节点 ${request.nodeId} 不存在`);
    const nodeKind = kindForNodeType(node.type);
    if (nodeKind !== request.kind) return fail("EDIT_SESSION_TARGET_INVALID", "节点类型与会话种类不匹配");
    const currentIdentity = currentIdentityOfNode(exported.canvas, request.nodeId, request.kind);
    if (currentIdentity === null) return fail("EDIT_SESSION_TARGET_INVALID", "节点当前无可归档内容");

    const key = `begin:${request.sessionId}`;
    const existing = await this.completions.get(request.canvasId, request.nodeId, key);
    if (existing) {
      return {
        ok: true,
        sessionId: request.sessionId,
        baselineContentIdentity: existing.baselineContentIdentity,
        revision: exported.canvas.revision
      };
    }
    const timestamp = this.now();
    await this.completions.put({
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      sessionId: request.sessionId,
      requestId: key,
      kind: request.kind,
      payloadFingerprint: request.baselineContentIdentity,
      baselineContentIdentity: currentIdentity,
      status: "prepared",
      contentIdentity: currentIdentity,
      entryId: null,
      revision: exported.canvas.revision,
      contentCommitted: false,
      pendingEntries: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return { ok: true, sessionId: request.sessionId, baselineContentIdentity: currentIdentity, revision: exported.canvas.revision };
  }

  /** complete：提交最终编辑版本（design D6）。 */
  async complete(request: EditSessionCompleteRequest): Promise<EditCompletionResult> {
    let existing = await this.completions.get(request.canvasId, request.nodeId, request.requestId);
    if (existing) {
      const fingerprint = editCompletePayloadFingerprint(request);
      if (existing.payloadFingerprint !== fingerprint) {
        return failWithReceipt(existing, "EDIT_SESSION_REQUEST_CONFLICT", "同一 requestId 携带了不同内容");
      }
      existing = await recoverPrepared(this.ctx, existing);
      if (existing.status === "completed" || existing.status === "history-pending") {
        if (existing.status === "history-pending") await publishPending(this.ctx, existing);
        const refreshed = (await this.completions.get(request.canvasId, request.nodeId, request.requestId)) ?? existing;
        return { ok: true, receipt: toReceipt(refreshed) };
      }
      if (existing.status === "conflict" || existing.status === "abandoned") {
        return failWithReceipt(existing, existing.errorCode ?? "EDIT_SESSION_CONFLICT", existing.errorMessage ?? "请求已被终止");
      }
    }

    return request.kind === "image" ? completeImage(this.ctx, request) : completeModel(this.ctx, request);
  }

  /** status：受保护查询（design D6）；pending 不误报已保存。 */
  async status(request: { canvasId: string; nodeId: string; requestId: string }): Promise<EditSessionStatusResponse> {
    const found = await this.completions.get(request.canvasId, request.nodeId, request.requestId);
    if (!found) return fail("EDIT_SESSION_NOT_FOUND", "编辑完成回执不存在");
    const record = await recoverPrepared(this.ctx, found);
    if (record.status === "history-pending") await publishPending(this.ctx, record);
    const refreshed = (await this.completions.get(request.canvasId, request.nodeId, request.requestId)) ?? record;
    return { ok: true, receipt: toReceipt(refreshed) };
  }

  verifyProjectReferences(request: ImageProjectReferencesRequest) {
    return verifyProjectReferences(this.ctx, request);
  }

  /** 某节点当前是否存在活动（prepared）模型编辑会话（design D5）。 */
  async hasActiveModelSession(canvasId: string, nodeId: string): Promise<boolean> {
    const records = await this.completions.listByNode(canvasId, nodeId);
    return records.some((record) => record.kind === "model" && record.status === "prepared");
  }

  /** 放弃：仅允许尚未提交内容的 prepared 草稿（design D6/D7）。 */
  async abandon(request: { canvasId: string; nodeId: string; requestId: string }): Promise<
    { ok: true; status: "abandoned" } | { ok: false; code: EditSessionErrorCode; message: string }
  > {
    const found = await this.completions.get(request.canvasId, request.nodeId, request.requestId);
    if (!found) return fail("EDIT_SESSION_NOT_FOUND", "编辑完成回执不存在");
    const record = await recoverPrepared(this.ctx, found);
    if (record.contentCommitted || record.status === "completed" || record.status === "history-pending") {
      return fail("EDIT_SESSION_CONFLICT", "内容已权威提交，不能放弃其待登记义务");
    }
    await this.completions.put({ ...record, status: "abandoned", updatedAt: this.now() });
    return { ok: true, status: "abandoned" };
  }

  /** 启动/重试补偿：登记所有 `history-pending` 的固定 snapshot（design D6）。 */
  async processPending(limit = 100): Promise<{ scanned: number; completed: number }> {
    const prepared = await this.completions.listPreparedImages(limit);
    const recovered = new Set<string>();
    let completed = 0;
    for (const record of prepared) {
      if (record.kind !== "image" || record.pendingEntries.length === 0) continue;
      const result = await recoverPrepared(this.ctx, record);
      recovered.add(`${record.canvasId}:${record.nodeId}:${record.requestId}`);
      if (result.status === "completed") completed++;
    }
    const pending = await this.completions.listByStatus("history-pending", limit);
    let scanned = recovered.size;
    for (const record of pending) {
      if (!recovered.has(`${record.canvasId}:${record.nodeId}:${record.requestId}`)) scanned++;
      const result = await publishPending(this.ctx, record);
      if (result) completed += 1;
    }
    return { scanned, completed };
  }
}

function fail<T extends { ok: false; code: EditSessionErrorCode; message: string }>(code: EditSessionErrorCode, message: string): T {
  return { ok: false, code, message } as T;
}
