/**
 * Ark 视频兼容类型（change: 2026-10-06-extensionize-ark-provider；
 *  change: 2026-10-07-remove-residual-compatibility —— 删除 Provider bundle 兼容形状）。
 *
 * Ark Provider 已迁为后端插件（`@woohaa3/extension-ark-provider`）；Task 领域不再持有其实现，
 * 只保留**输入 materialization** 需要的纯结构类型（不含实现，避免 Task 依赖插件包）。
 */

/** 参考输入 binary（由 worker 从 Media 读取后交给素材注册）。 */
export type ArkVideoImageBinary = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
};

export type ArkVideoImageAssetInput = {
  reference: { url: string; role: string; metadata?: Record<string, unknown> };
  binary: ArkVideoImageBinary;
};

export type ArkVideoImageAsset = { assetId: string; uri: string; status: string };
