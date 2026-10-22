/**
 * 扩展拥有的后台活动（change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 与 durable 任务活动严格分开：没有 taskKey/runId，不进入任务历史，也不驱动 Provider。
 * 它只是画布活动浮层的 UI 投影，由扩展在 canvas scope 内通过
 * `extension.activity.updated` 事件发布；同一 `id` 只保留一条记录。
 *
 * 安全边界与任务活动一致：只承载可读摘要（标题、进度、失败原因、可定位节点），
 * 不含提示词、参数、媒体字节或 provider 凭据。
 */

/** 后台活动状态；与任务活动同构，供浮层复用状态灯与文案。 */
export type BackgroundActivityStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 已知后台活动种类；新增种类时同步扩展浮层的动作文案。 */
export type BackgroundActivityKind = "shot-reference-recording";

export type BackgroundActivityJob = {
  /** 稳定身份：同一目标（如某镜头当前版本）只保留一条记录。 */
  id: string;
  /** 事件按画布过滤，避免跨画布串台。 */
  canvasId: string;
  kind: BackgroundActivityKind;
  /** 主行文案，例如「片场 · 镜头 1」。 */
  title: string;
  status: BackgroundActivityStatus;
  /** 进度 0..1；缺失时不显示百分比。 */
  progress?: number;
  /** 可读细节（如失败原因）；缺失不显示。 */
  detail?: string;
  /** 可定位的画布节点（可选）；浮层只做定位，不做任务详情。 */
  nodeId?: string;
  updatedAt: string;
};
