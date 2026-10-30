/**
 * 转换媒体读取端口实现（film-set 侧）
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.2 / design D2/D6）。
 *
 * 把**稳定媒体字节来源**（宿主注入：Media 能力按 storageKey 读取，不接触 provider URL 或浏览器
 * 状态）与 film-set 自己的**有界 CPU 抽帧**（`video-frames.ts` 的 ffprobe/ffmpeg）组合成公共契约
 * `FilmSetConversionMediaReader`：
 *
 * - `readAsset`：图片/视频原文件字节（真实视觉输入的前提），有明确字节上界；
 * - `readVideoFrames`：模型不支持原生视频时，在所选范围内抽取有时间戳、覆盖首尾与主要变化的帧组；
 *   无法抽取（缺 ffmpeg、超预算、无可用帧）时抛出可读原因，由调用方拒绝或提示，**不**静默降级
 *   成纯文字 prompt。
 *
 * 抽帧/时长探测实现可注入（测试用确定性替身；生产使用真实 ffmpeg/ffprobe）。
 */
import type { FilmSetConversionFrame, FilmSetConversionMediaReader } from "@woohaa3/contracts";
import { extractFilmSetVideoFrames, probeFilmSetVideoDuration, type FilmSetVideoFrame } from "./video-frames.js";

/** 单个稳定资产的读取字节上界（原文件）；超出即拒绝并给出可读原因。 */
export const FILM_SET_CONVERSION_MAX_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * 稳定字节来源：只接受 storageKey（不接触外网 URL）。
 *
 * `canvasId` 可选：远端画布的素材只在托管存储里，宿主在能拿到画布 id 时必须透传；
 * 省略表示与画布无关（保持旧行为）。
 */
export type FilmSetConversionAssetReader = (
  storageKey: string,
  canvasId?: string,
  extensionId?: string
) => Promise<{ bytes: Uint8Array; contentType: string }>;

export type FilmSetConversionMediaReaderOptions = {
  /** 稳定资产字节来源（宿主 Media 能力；测试可注入替身）。 */
  read: FilmSetConversionAssetReader;
  /** 抽帧实现（缺省真实 ffmpeg/ffprobe；测试注入确定性替身）。 */
  extractFrames?: typeof extractFilmSetVideoFrames;
  /** 时长探测实现（缺省真实 ffprobe；测试注入确定性替身）。 */
  probeDuration?: typeof probeFilmSetVideoDuration;
};

export function createFilmSetConversionMediaReader(
  options: FilmSetConversionMediaReaderOptions
): FilmSetConversionMediaReader {
  const extractFrames = options.extractFrames ?? extractFilmSetVideoFrames;
  const probeDuration = options.probeDuration ?? probeFilmSetVideoDuration;

  const read = async (storageKey: string, canvasId?: string): Promise<{ bytes: Uint8Array; contentType: string }> => {
    const media = await options.read(storageKey, canvasId, "film-set");
    if (!(media.bytes instanceof Uint8Array) || media.bytes.byteLength === 0) {
      throw new Error("来源素材内容为空，无法读取");
    }
    if (media.bytes.byteLength > FILM_SET_CONVERSION_MAX_ASSET_BYTES) {
      throw new Error("来源素材超过转换读取预算，请改用更短的素材或缩小范围");
    }
    if (typeof media.contentType !== "string" || media.contentType.trim() === "") {
      throw new Error("来源素材缺少媒体类型，无法读取");
    }
    return { bytes: media.bytes, contentType: media.contentType };
  };

  return {
    readAsset: (storageKey, canvasId) => read(storageKey, canvasId),
    async readVideoFrames(input): Promise<FilmSetConversionFrame[]> {
      if (!Number.isFinite(input.maxFrames) || input.maxFrames <= 0) {
        throw new Error("所选模型未声明视频帧预算，无法读取视频内容");
      }
      const media = await read(input.storageKey, input.canvasId);
      const durationSeconds = input.durationSeconds ?? await probeDuration(media.bytes);
      const frames: FilmSetVideoFrame[] = await extractFrames({
        bytes: media.bytes,
        contentType: media.contentType,
        ...(input.range ? { range: input.range } : {}),
        durationSeconds,
        maxFrames: input.maxFrames
      });
      if (frames.length === 0) throw new Error("未能从视频中抽取可用帧，无法转换");
      // 只透出契约字段，不泄露内部形状。
      return frames.map((frame) => ({
        timestampSeconds: frame.timestampSeconds,
        bytes: frame.bytes,
        contentType: frame.contentType
      }));
    }
  };
}
