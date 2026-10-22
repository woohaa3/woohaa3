/**
 * 模型镜头截图会话
 * （change: add-model-editor-gizmo-shot-capture，任务 4.1–4.3；design D4/D5）。
 *
 * 复用视频截帧的稳定媒体与原子命令链：Bevy/测试注入的 `captureSink` 返回 PNG Blob →
 * Media Service 上传为稳定 ready image asset → 通过 `planUploadedNode` 在源模型 2D 位置旁
 * 规划图片节点 → 一个 `asset.upsert + node.add` 命令批次提交。
 *
 * 失败语义（design D5）：
 * - 同一镜头只保留一个截图节点；再截一次重拍并换掉这张图；
 * - 上传失败/readback 失败/命令拒绝时不留 canonical 部分状态；
 * - 快速切换镜头或重复触发由 capture generation 丢弃迟到结果。
 *
 * 本模块只持有浏览器本地生成状态；Blob/object URL 绝不进入 canonical canvas / Y.Doc。
 */
import type { StoredAsset } from "@woohaa3/contracts";
import { buildUploadedAsset, planUploadedNode, type UploadedMedia } from "../../../extension-api/upload-asset.js";
import { planConnectEdge } from "../../../extension-api/command-planner.js";
import type { CanvasCommand } from "@woohaa3/contracts";

export type ShotCaptureSource = {
  /** 源模型节点的 2D 画布位置与尺寸（用于相邻规划）。 */
  position: { x: number; y: number };
  width: number;
};
export type ShotCaptureFrame = { blob: Blob };

/** 片场截图的稳定来源说明（不创建 edge；change: 2026-10-08-make-film-set-model-only）。 */
export type ModelShotOrigin = import("../../../extension-api/model-workspace.js").ModelCaptureOrigin;

export type ShotCaptureDeps = {
  /** 渲染并回读 PNG（Bevy/测试注入）。 */
  render: (input: { nodeId: string; cameraId: string; captureId: string }) => Promise<{ ok: true; blob: Blob } | { ok: false; code: string; message: string }>;
  /** Media Service 上传。 */
  upload: (blob: Blob, captureId: string) => Promise<{ ok: true; media: UploadedMedia } | { ok: false; message: string }>;
  /** 提交命令批次；返回是否被授权接受。 */
  submit: (commands: CanvasCommand[], commandId: string) => { ok: boolean; message?: string; settled?: Promise<{ state: string; error?: string | null }> };
  /** 读取源模型当前 2D 位置。 */
  readSource: (nodeId: string) => ShotCaptureSource | null;
  /** 该镜头的截图节点是否已在画布上。有则更新图片，不再 `node.add`。 */
  findNode?: (nodeId: string) => boolean;
  /**
   * 源节点是否为片场，并返回截图的稳定来源说明
   * （behavior: 片场截图不创建 edge，只保存稳定来源说明；普通 model3d 返回 null 保留既有边）。
   * `change: 2026-10-08-make-film-set-model-only`。
   */
  captureOrigin?: (nodeId: string, cameraId: string) => ModelShotOrigin | null;
  /**
   * 截图前等待片场媒体目标帧就绪（change: 2026-10-08-make-film-set-model-only，任务 4.3）。
   *
   * 仅片场需要；缺省视为就绪。返回 false 表示视频帧未在界内就绪，按稳定失败处理，不用旧帧冒充。
   */
  awaitCompositeAssetMediaReady?: (nodeId: string) => Promise<boolean>;
  /** 当前会话是否可写。 */
  isWritable: () => boolean;
  /** 时间源（测试可注入）。 */
  now?: () => string;
  /** 生成稳定 captureId（测试可注入）。 */
  createCaptureId?: () => string;
};

export type ShotCaptureResult =
  | { ok: true; status: "inserted" | "duplicate"; nodeId: string; entryId: string }
  | { ok: false; code: string; message: string };

/** 已成功提交的 captureId → 结果（幂等：同 captureId 重试不重复建节点）。 */
type CaptureRecord = { nodeId: string; assetId: string };

export class ModelShotCaptureSession {
  private readonly committed = new Map<string, CaptureRecord>();
  /** 当前活动 capture（busy 门禁）；null 表示空闲。 */
  private active: string | null = null;

  constructor(private readonly deps: ShotCaptureDeps) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * 执行一次截图。`captureId` 按镜头稳定，用来找到要刷新的那一个节点；
   * 缺省自动生成。
   */
  async capture(input: { nodeId: string; cameraId: string; cameraName?: string; captureId?: string; origin?: ModelShotOrigin; isCurrent?: () => boolean }): Promise<ShotCaptureResult> {
    if (this.active !== null) {
      return { ok: false, code: "busy", message: "已有截图进行中" };
    }
    const captureId = input.captureId ?? this.deps.createCaptureId?.() ?? `capture-${Date.now().toString(36)}`;
    if (!this.deps.isWritable()) {
      return { ok: false, code: "readonly", message: "只读会话无法截图" };
    }
    this.active = captureId;
    try {
      const current = () => this.deps.isWritable() && (input.isCurrent?.() ?? true);
      const stale = () => ({ ok: false as const, code: "stale-capture", message: "片段、播放时刻或内容已变化，截图已取消" });
      if (!current()) return stale();
      const source = this.deps.readSource(input.nodeId);
      if (!source) return { ok: false, code: "unknown-node", message: `源模型 ${input.nodeId} 不存在` };

      // 片场：等待视频锁定帧就绪后再离屏绘制（change: 2026-10-08-make-film-set-model-only，任务 4.3）。
      const origin = input.origin ?? this.deps.captureOrigin?.(input.nodeId, input.cameraId) ?? null;
      if (origin) {
        const ready = await (this.deps.awaitCompositeAssetMediaReady?.(input.nodeId) ?? Promise.resolve(true));
        if (!ready) {
          return { ok: false, code: "media-not-ready", message: "素材目标帧未就绪" };
        }
      }

      if (!current()) return stale();
      const rendered = await this.deps.render({ nodeId: input.nodeId, cameraId: input.cameraId, captureId });
      if (!rendered.ok) return { ok: false, code: rendered.code, message: rendered.message };

      if (!current()) return stale();
      const uploaded = await this.deps.upload(rendered.blob, captureId);
      if (!uploaded.ok) return { ok: false, code: "upload-failed", message: uploaded.message };

      if (!current()) return stale();
      const file = { name: `model-shot-${captureId}.png`, type: "image/png", size: uploaded.media.size };
      const asset = buildUploadedAsset({
        media: uploaded.media,
        mediaKind: "image",
        file,
        ...(this.deps.now ? { now: this.deps.now() } : {})
      });
      const nodeId = `model-shot-${captureId}`;
      // 复合资产截图：原子创建图片节点并保存稳定来源说明，**不创建任何 edge/mapping**
      // （change: 2026-10-08-make-film-set-model-only，任务 4.4）。
      if (origin && !this.committed.has(captureId) && this.deps.findNode?.(nodeId) !== true) {
        const commands: CanvasCommand[] = planUploadedNode({
          nodeType: "image",
          position: { x: source.position.x + source.width + 40, y: source.position.y },
          file,
          asset,
          nodeId
        });
        const shotNode = commands.find((command) => command.type === "node.add");
        if (shotNode && shotNode.type === "node.add") {
          shotNode.nodeData = {
            ...(shotNode.nodeData ?? {}),
            ...origin.nodeData
          } as never;
        }
        const commandId = `web-model-shot-${captureId}-${asset.id}-${crypto.randomUUID()}`;
        const submitted = this.deps.submit(commands, commandId);
        if (!submitted.ok) {
          return { ok: false, code: "command-rejected", message: submitted.message ?? "画布命令被拒绝" };
        }
        const outcome = await submitted.settled;
        if (outcome?.state === "rejected") return { ok: false, code: "command-rejected", message: outcome.error ?? "截图未能保存，请重试" };
        this.committed.set(captureId, { nodeId, assetId: asset.id });
        return { ok: true, status: "inserted", nodeId, entryId: asset.id };
      }
      // 同一镜头的截图节点已经在画布上，或本会话刚刚建过时，再 node.add 会被拒绝。
      // 这时重拍并换掉这张图，不新建节点、不新建边。
      const replacing = this.committed.has(captureId) || this.deps.findNode?.(nodeId) === true;
      const commands: CanvasCommand[] = replacing
        ? [
            { type: "asset.upsert", asset },
            {
              type: "nodeData.patch",
              nodeId,
              value: {
                title: file.name,
                outputAssetId: asset.id,
                resourceKind: "image",
                taskStatus: "successed"
              }
            }
          ]
        : planUploadedNode({
            nodeType: "image",
            // 源模型保存的 2D 位置相邻规划（不用聚焦场景坐标）。
            position: { x: source.position.x + source.width + 40, y: source.position.y },
            file,
            asset,
            nodeId
          });
      if (!replacing && origin === null) {
        // 追加「源模型 → 截图」语义关系边（change: 对齐 xyflow-bevy 镜头截图交互）。
        // 关系标签标识为镜头截图；边与节点在同一命令批次内原子提交。
        const label = `镜头截图 · ${input.cameraName ?? input.cameraId}`;
        commands.push(
          ...planConnectEdge({
            edgeId: `edge-${input.nodeId}-${nodeId}`,
            source: input.nodeId,
            target: nodeId,
            data: { label }
          })
        );
      }
      // 每次主动重拍都是新操作：A → B → A 也必须把节点重新指向 A，不能复用
      // 图片 A 首次提交的幂等键，否则服务端返回历史 duplicate 而不更新节点。
      // 同一次提交的传输重试由 canvasSession 保留此 commandId。
      const commandId = `${replacing ? "web-model-shot-patch" : "web-model-shot-add"}-${captureId}-${asset.id}-${crypto.randomUUID()}`;
      const submitted = this.deps.submit(commands, commandId);
      if (!submitted.ok) {
        return { ok: false, code: "command-rejected", message: submitted.message ?? "画布命令被拒绝" };
      }
      const outcome = await submitted.settled;
      if (outcome?.state === "rejected") return { ok: false, code: "command-rejected", message: outcome.error ?? "截图未能保存，请重试" };
      this.committed.set(captureId, { nodeId, assetId: asset.id });
      return { ok: true, status: "inserted", nodeId, entryId: asset.id };
    } finally {
      this.active = null;
    }
  }

  /** 诊断/测试：已成功提交的 captureId 数量。 */
  committedCount(): number {
    return this.committed.size;
  }
}

export type { StoredAsset };
