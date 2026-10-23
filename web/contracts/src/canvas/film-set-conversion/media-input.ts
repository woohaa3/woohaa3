/**
 * 转换媒体输入装配（共享 helper，任务 2.2 / design D2）
 * （change: 2026-10-13-add-node-to-film-set-shortcut）。
 *
 * 把「冻结来源 + 已解析 storageKey + 模型能力」变成**真实视觉输入**：
 * - 图片：读取稳定资产原文件作为单个附件；
 * - 视频：模型支持原生视频时直接传原件；否则在服务端按所选范围抽取有时间戳、覆盖首尾与主要
 *   变化的帧组，作为一组附件并把时间戳交给指令。
 *
 * 超出模型预算（帧数/时长/多图能力缺失）时**抛出可读原因**，由调用方拒绝并要求用户重选范围，
 * **绝不**静默截断所选范围或降级成纯文字 prompt。纯逻辑 + 注入端口，不接触任何 provider SDK。
 */
import type { FilmSetConversionAdapterCapabilities } from "./capabilities.js";
import type { FilmSetConversionMediaReader } from "./generator.js";
import type { FilmSetConversionSourceKind } from "./types.js";

/** 一个真实视觉附件（原文件或抽取帧）。 */
export type FilmSetConversionMediaAttachment = {
  fileName: string;
  bytes: Uint8Array;
  contentType: string;
};

export type FilmSetConversionMediaInputRequest = {
  media: FilmSetConversionMediaReader;
  sourceKind: FilmSetConversionSourceKind;
  storageKey: string;
  /**
   * 素材所属画布 id（可选）：远端画布的字节只在托管存储里，能拿到就必须透传。
   * 省略表示与画布无关，保持旧行为。
   */
  canvasId?: string;
  /** 资产声明的 contentType 提示（metadata 优先，否则按 mediaKind 推断）。 */
  contentType: string;
  range?: { startSeconds: number; endSeconds: number };
  durationSeconds?: number;
  capabilities: FilmSetConversionAdapterCapabilities;
};

export type FilmSetConversionMediaInputResult = {
  attachments: FilmSetConversionMediaAttachment[];
  /** 是否以原生视频输入（否则为抽帧图组）。 */
  nativeVideo: boolean;
  /** 抽帧时实际输入给模型的时间戳（秒）。 */
  frameTimestamps?: number[];
  /** 输入方式说明（记录到任务详情；不含实现细节泄漏）。 */
  note?: string;
};

/**
 * 装配真实视觉输入；模型确实不能承载该输入（真实能力不足）或无法读取时抛出可读原因
 * （调用方转为 `budget-exceeded` / `source-not-ready` 等错误码；这不是应用自设总量额度，
 * 见 change: 2026-10-22-remove-agent-execution-limits）。
 */
export async function readFilmSetConversionMediaInput(
  input: FilmSetConversionMediaInputRequest
): Promise<FilmSetConversionMediaInputResult> {
  if (input.sourceKind === "image") {
    const asset = await input.media.readAsset(input.storageKey, input.canvasId);
    return {
      attachments: [{ fileName: "source-image", bytes: asset.bytes, contentType: asset.contentType || input.contentType }],
      nativeVideo: false
    };
  }
  if (input.sourceKind !== "video") throw new Error("该来源种类不需要媒体输入");

  // 原生视频：adapter 直接传原件（时间戳不适用）。
  if (input.capabilities.input.videoInput) {
    const asset = await input.media.readAsset(input.storageKey, input.canvasId);
    return {
      attachments: [{ fileName: "source-video", bytes: asset.bytes, contentType: asset.contentType || input.contentType }],
      nativeVideo: true
    };
  }
  // 帧组输入：必须有多图能力与抽帧实现；否则拒绝，不静默降级为文字。
  const maxImages = input.capabilities.input.maxImages;
  if (!input.capabilities.input.imageInput || maxImages <= 1 || !input.media.readVideoFrames) {
    throw new Error("所选模型不支持视频或多图输入，无法读取视频内容");
  }
  const declaredMaxFrames = input.capabilities.input.maxFrames > 0 ? input.capabilities.input.maxFrames : maxImages;
  const maxFrames = Math.max(1, Math.min(declaredMaxFrames, maxImages));
  const frames = await input.media.readVideoFrames({
    storageKey: input.storageKey,
    ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {}),
    ...(input.range ? { range: input.range } : {}),
    ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
    maxFrames
  });
  if (frames.length === 0) throw new Error("服务端未产出可用视频帧，无法转换");
  if (frames.length > maxFrames) throw new Error("服务端返回的帧数超过所选模型的真实输入能力，请重新选择范围");
  return {
    attachments: frames.map((frame, index) => ({
      fileName: `frame-${index + 1}-${frame.timestampSeconds.toFixed(3)}s`,
      bytes: frame.bytes,
      contentType: frame.contentType
    })),
    nativeVideo: false,
    frameTimestamps: frames.map((frame) => frame.timestampSeconds),
    note: `frames=${frames.length},max=${maxFrames}`
  };
}
