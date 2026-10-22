/**
 * 视频编辑标记图合成
 * （change: 2026-09-28-split-frontend-god-plugins，task 5.4；从 video-edit-dialog 拆出）。
 *
 * 从 `<video>` 当前帧绘制到 canvas 并叠加 shape，产出 PNG Blob。跨域 canvas 会抛
 * `SecurityError`，由调用方转为可恢复提示。
 */
import type { VideoEditIntent } from "@woohaa3/contracts";
import { drawShape } from "./video-edit-helpers.js";

export async function composeAnnotatedFrame(video: HTMLVideoElement, intent: VideoEditIntent): Promise<Blob> {
  const sourceWidth = video.videoWidth || intent.frameWidth;
  const sourceHeight = video.videoHeight || intent.frameHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("无法读取视频帧尺寸");
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建标记图画布");
  context.drawImage(video, 0, 0, sourceWidth, sourceHeight);
  context.getImageData(0, 0, 1, 1); // tainted canvas → SecurityError（安全失败）。
  const content = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  for (const shape of intent.annotationShapes) drawShape(context, shape, content);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("生成标记图失败");
  return blob;
}
