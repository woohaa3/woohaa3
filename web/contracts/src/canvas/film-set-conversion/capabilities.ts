/**
 * 转换 adapter 能力声明与服务端可用性判据
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1/2.1 / design D6）。
 *
 * 转换模型必须显式声明：真实视觉输入（图片 / 多图 / 原生视频）、结构化片场候选输出与真实
 * 输入能力。能力未知或仅文字能力时服务端**在调用上游之前**拒绝，并提供可读原因；不把
 * 「能输出 JSON」等同于「已支持片场校验与写入」。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 7.1 / design D7：`maxImages` /
 * `maxFrames` / `maxDurationSeconds` 只表达**所选模型的真实输入能力**（一次请求能接收多少
 * 图/帧、支持多长的视频），不是应用人为设置的执行额度；不声明即不宣称能力。原先声明的
 * `maxPixels`（400 万像素）是应用自造的总量门禁，已删除。
 */
import type { FilmSetConversionSourceKind } from "./types.js";

/** 视觉/多模态输入能力（真实模型输入能力，非应用执行额度）。 */
export type FilmSetConversionInputCapability = {
  /** 是否接受真实图片内容（非 URL 文本）。 */
  imageInput: boolean;
  /** 单次最多可传入的图片数量（`0` 表示不支持多图）。 */
  maxImages: number;
  /** 是否接受原生视频输入。 */
  videoInput: boolean;
  /** 不支持原生视频时，服务端可抽取的帧数上限。 */
  maxFrames: number;
  /** 可处理的最长视频时长（秒）；`0` 表示未声明上限。 */
  maxDurationSeconds: number;
};

/** 转换 adapter 声明能力。 */
export type FilmSetConversionAdapterCapabilities = {
  /** 是否支持结构化片场候选输出（受约束 JSON）。 */
  structuredCandidateOutput: boolean;
  input: FilmSetConversionInputCapability;
};

/** 仅支持文字、无视觉能力的默认声明（用于「已知不可用」模型的显式表达）。 */
export const TEXT_ONLY_CONVERSION_CAPABILITIES: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: false,
  input: {
    imageInput: false,
    maxImages: 0,
    videoInput: false,
    maxFrames: 0,
    maxDurationSeconds: 0
  }
};

/**
 * 判断给定能力声明是否能承担某来源种类的转换。
 *
 * - 未提供能力（`undefined`）：能力未知，拒绝（不开放一键调用）；
 * - 图片：必须有真实图片输入；
 * - 视频：支持原生视频，或支持多图（服务端抽帧后作为一组图片输入）；
 * - 任何种类都要求结构化片场候选输出。
 *
 * 返回 `null` 表示可用；否则返回可读原因（不暴露实现细节）。
 */
export function filmSetConversionCapabilityRejection(
  kind: FilmSetConversionSourceKind,
  capabilities: FilmSetConversionAdapterCapabilities | undefined
): string | null {
  if (!capabilities) return "所选模型未声明转换能力，无法一键转为片场";
  if (!capabilities.structuredCandidateOutput) {
    return "所选模型不支持结构化片场候选输出，无法转为片场";
  }
  const input = capabilities.input;
  if (kind === "image") {
    return input.imageInput ? null : "所选模型未声明图片视觉输入能力";
  }
  if (kind === "video") {
    if (input.videoInput) return null;
    if (input.imageInput && input.maxImages > 1) return null;
    return "所选模型不支持视频或多图输入，无法读取视频内容";
  }
  // model3d 复制不依赖 LLM，因此不在此判定；防御性返回原因。
  return "3D 复制不需要视觉模型";
}

/** 该能力声明是否提供任何形式的视频输入（原生或抽帧多图）。 */
export function supportsVideoConversion(capabilities: FilmSetConversionAdapterCapabilities | undefined): boolean {
  if (!capabilities) return false;
  return capabilities.input.videoInput || (capabilities.input.imageInput && capabilities.input.maxImages > 1);
}

/**
 * 能力判定的稳定错误分类：调用方据此选择错误码，不解析可读文案。
 *
 * - `model-not-vision-capable`：未声明能力或缺少所需视觉输入；
 * - `model-no-structured-output`：能看图但不声明结构化片场候选输出。
 */
export function filmSetConversionCapabilityRejectionCode(
  kind: FilmSetConversionSourceKind,
  capabilities: FilmSetConversionAdapterCapabilities | undefined
): { code: "model-not-vision-capable" | "model-no-structured-output"; message: string } | null {
  const message = filmSetConversionCapabilityRejection(kind, capabilities);
  if (message === null) return null;
  if (capabilities && !capabilities.structuredCandidateOutput) {
    return { code: "model-no-structured-output", message };
  }
  return { code: "model-not-vision-capable", message };
}
