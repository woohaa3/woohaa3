/**
 * 片场组外显镜头节点的只读参数投影。
 *
 * 这些节点是标准 image/video，但内容完全由所属片场镜头托管；它们没有可提交的
 * 生成配置，因此执行面板不应展示图片/视频生成目录，而应展示镜头本身的输出参数。
 *
 * 参数只是**读取**已有契约投影（片段画幅、时间线），不写画布、不创建第二份权威数据：
 * - 分辨率与画面比例来自镜头的 `initialCamera.aspect`，与录像/静态参考使用同一
 *   `filmSetExportVideoSize` 规则；
 * - 时长、循环来自片段时间线；
 * - 帧率沿用镜头参考固定 profile。
 */
import {
  filmSetExportFrameRate,
  filmSetExportVideoSize,
  managedShotPreviewOwnershipOf,
  readFilmSetAnimationProjection,
  resolveFilmSetClip,
  type ServerCanvas
} from "@woohaa3/contracts";

export type ShotMediaParameters = {
  /** 节点媒体类型；与镜头静态/动态一致。 */
  kind: "image" | "video";
  /** 镜头名称（片段名），作为面板标题。 */
  title: string;
  /** 输出像素宽。 */
  width: number;
  /** 输出像素高。 */
  height: number;
  /** 画面比例（如 `16:9`）。 */
  aspect: string;
  /** 动态镜头时长（秒）；静态图片为 0。 */
  durationSeconds: number;
  /** 视频帧率；静态图片为 0。 */
  frameRate: number;
  /** 动态镜头是否循环。 */
  loop: boolean;
};

const ASPECT_PATTERN = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;

/** 读取托管镜头节点的只读参数；不是片场组外显镜头时返回 null。 */
export function readShotMediaParameters(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null | undefined
): ShotMediaParameters | null {
  if (!canvas || !nodeId) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node || (node.type !== "image" && node.type !== "video")) return null;
  const ownership = managedShotPreviewOwnershipOf(canvas.nodeData[nodeId]);
  if (!ownership) return null;
  const animation = readFilmSetAnimationProjection(canvas, ownership.filmSetNodeId);
  if (!animation) return null;
  const view = resolveFilmSetClip(animation, ownership.clipId);
  if (!view) return null;
  const dynamic = view.clip.kind === "dynamic";
  // 节点类型与镜头静态/动态必须一致；不一致时宁可回到原执行面板，也不展示猜测值。
  if ((node.type === "video") !== dynamic) return null;
  const aspect = typeof view.initialCamera.aspect === "string" && ASPECT_PATTERN.test(view.initialCamera.aspect)
    ? view.initialCamera.aspect
    : "16:9";
  const size = filmSetExportVideoSize(aspect);
  return {
    kind: node.type,
    title: view.clip.name || nodeId,
    width: size.width,
    height: size.height,
    aspect,
    durationSeconds: dynamic ? view.timeline.duration : 0,
    frameRate: dynamic ? filmSetExportFrameRate() : 0,
    loop: dynamic ? view.timeline.loop : false
  };
}

/** 时长展示：整数秒不带小数，其余保留一位有效小数（最多两位）。 */
export function formatShotDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 秒";
  return `${Number(seconds.toFixed(2))} 秒`;
}
