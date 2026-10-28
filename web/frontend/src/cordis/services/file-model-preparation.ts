/**
 * GLB 文件模型的渲染准备（change: 2026-10-28-support-glb-model-nodes）。
 *
 * 职责边界：
 * - 只读取节点引用的**画布作用域稳定资产**，绝不读取临时 URL 或本机路径；
 * - 原始 GLB 解析为 Scene IR（纯 contracts 解析器），内嵌纹理在浏览器解码后经既有模型纹理
 *   通道上传（内容寻址 id，重复准备不会重复占显存）；
 * - 失败返回稳定的 `fail:<阶段>:<原因>` 状态，由 model-scene 写入节点的模型状态字段，节点保留
 *   规范引用并显示失败，而不是静默降级为空模型。
 *
 * 本模块不写 nodeData、不提交命令，也不持有 GPU 资源生命周期。
 */
import {
  GLB_MAX_TEXTURE_EDGE,
  SCENE_IR_V2_VERSION,
  isGlbModelNodeData,
  readGlbModelAssetId,
  parseGlbModel,
  prepareModelResource,
  validateModelSceneIrV2,
  type GlbTexture,
  type NodeCapabilityContext,
  type NodePreparationResult
} from "@woohaa3/contracts";
import { readCanonicalMedia } from "./media-remote.js";

/** 纹理解码后总字节上限（8 张 1024² RGBA 仍有充足余量）。 */
const MAX_DECODED_TEXTURE_BYTES = 64 * 1024 * 1024;

/** 页面级运行时端口：只暴露 preparation 需要的能力，便于测试替身。 */
export type FileModelRuntimePort = {
  runtime(): {
    setModelMediaTexture(
      id: string,
      width: number,
      height: number,
      rgba: Uint8Array,
      source?: string
    ): boolean | void;
  } | null;
};

/** 纹理上传 id 前缀：Rust 侧据此把媒体平面通道中的 GLB 纹理路由到模型纹理表。 */
export const MODEL_TEXTURE_ID_PREFIX = "modeltex:" as const;

export type FileModelPreparation = {
  executionKey(context: NodeCapabilityContext): string | undefined;
  prepare(context: NodeCapabilityContext): Promise<NodePreparationResult>;
};

/** 读取节点引用的资产身份，作为重新准备的唯一依据（不含临时 URL）。 */
export function fileModelExecutionKey(context: NodeCapabilityContext): string | undefined {
  // 来源判别是权威内容：只要节点声明为文件模型，就由本路径处理，损坏/缺失的资产引用也必须
  // 显示明确失败，而不是回退成脚本模型。
  if (!isGlbModelNodeData(context.data)) return undefined;
  const assetId = readGlbModelAssetId(context.data);
  const asset = assetId ? context.canvas.assets.find((entry) => entry.id === assetId) : undefined;
  if (!asset) return `glb:${assetId}:missing`;
  const checksum = asset.metadata && typeof asset.metadata.checksum === "string" ? asset.metadata.checksum : "";
  return JSON.stringify(["glb", assetId, asset.status, checksum, asset.url ?? ""]);
}

export function createFileModelPreparation(deps: {
  /** 惰性读取页面运行时（install 阶段尚未注入）。 */
  runtime: () => FileModelRuntimePort | null;
  /** 资产字节读取（默认走既有 media-remote 同源读取）。 */
  read?: (asset: unknown, signal: AbortSignal | undefined, canvasId: string) => Promise<Blob>;
  /** 纹理解码（默认用 createImageBitmap + 2D canvas；测试可替换）。 */
  decodeTexture?: (texture: GlbTexture) => Promise<{ width: number; height: number; rgba: Uint8Array }>;
}): FileModelPreparation {
  // 每节点独立的取消句柄：同一节点的新准备取消上一轮，**不同节点互不干扰**。
  const controllers = new Map<string, AbortController>();
  const read = deps.read ?? readCanonicalMedia;
  const decode = deps.decodeTexture ?? decodeGlbTexture;

  return {
    executionKey: fileModelExecutionKey,
    async prepare(context: NodeCapabilityContext): Promise<NodePreparationResult> {
      const assetId = readGlbModelAssetId(context.data);
      if (!assetId) return { status: "fail:load:missing-asset:文件模型缺少资产引用" };
      const asset = context.canvas.assets.find((entry) => entry.id === assetId);
      if (!asset) return { status: "fail:load:missing-asset:模型资产不存在或已被删除" };
      if (asset.status !== "ready") return { status: "fail:load:asset-unavailable:模型资产尚未就绪" };
      if (asset.mediaKind !== "file") return { status: "fail:load:asset-kind:模型资产类型不匹配" };

      // 同一节点的新身份会取消上一轮下载；旧结果由 model-scene 的 identity 检查丢弃。
      controllers.get(context.node.id)?.abort();
      const controller = new AbortController();
      controllers.set(context.node.id, controller);
      const signal = controller.signal;
      const release = (): void => {
        if (controllers.get(context.node.id) === controller) controllers.delete(context.node.id);
      };

      let bytes: Uint8Array;
      try {
        const blob = await read(asset, signal, context.canvas.id);
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch (error) {
        release();
        if (signal.aborted) return { status: "fail:load:aborted" };
        return { status: `fail:load:read:${safeMessage(error, "模型文件下载失败")}` };
      }
      if (signal.aborted) {
        release();
        return { status: "fail:load:aborted" };
      }

      const parsed = parseGlbModel(bytes);
      if (!parsed.ok) {
        release();
        return { status: `fail:load:${parsed.code}:${parsed.message}` };
      }

      try {
        const validation = validateModelSceneIrV2({ version: SCENE_IR_V2_VERSION, ops: parsed.ops });
        if (!validation.ok) {
          return { status: `fail:compile:${validation.code}:${validation.message}` };
        }

        // 纹理解码/上传需要画布运行时。运行时可能在 WASM/原生附加完成前尚未就绪，
        // 这里按短间隔等待（而不是直接失败并且永不重试），让首屏加载与刷新后恢复都能完成。
        const runtime = parsed.textures.length > 0
          ? await waitForRuntime(deps, signal)
          : deps.runtime()?.runtime() ?? null;
        if (signal.aborted) return { status: "fail:load:aborted" };
        if (parsed.textures.length > 0 && !runtime) {
          return { status: "fail:execute:no-runtime:画布运行时尚未就绪" };
        }
        let decodedBytes = 0;
        for (const texture of parsed.textures) {
          if (signal.aborted) return { status: "fail:load:aborted" };
          let decoded: { width: number; height: number; rgba: Uint8Array };
          try {
            decoded = await decode(texture);
          } catch (error) {
            return { status: `fail:load:texture-decode:${safeMessage(error, "纹理解码失败")}` };
          }
          decodedBytes += decoded.rgba.byteLength;
          if (decodedBytes > MAX_DECODED_TEXTURE_BYTES) {
            return { status: "fail:load:texture-budget:纹理总大小超过上限" };
          }
          try {
            runtime?.setModelMediaTexture(
              `${MODEL_TEXTURE_ID_PREFIX}${texture.id}`,
              decoded.width,
              decoded.height,
              decoded.rgba,
              texture.id
            );
          } catch {
            return { status: "fail:execute:texture-upload:纹理上传失败" };
          }
        }

        return {
          status: "ok",
          resource: prepareModelResource({ sceneVersion: SCENE_IR_V2_VERSION, ops: validation.scene.ops })
        };
      } finally {
        // 纹理阶段也保留取消句柄：同一节点的下一轮准备可以中止旧解码/等待。
        release();
      }
    }
  };
}

/** 等待画布运行时就绪（仅纹理需要）；被取消或超时返回 null。 */
async function waitForRuntime(
  deps: { runtime: () => FileModelRuntimePort | null },
  signal: AbortSignal
): Promise<{ setModelMediaTexture(id: string, width: number, height: number, rgba: Uint8Array, source?: string): boolean | void } | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const runtime = deps.runtime()?.runtime() ?? null;
    if (runtime) return runtime;
    if (signal.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  // 只保留安全摘要：不泄漏 URL / 授权信息 / 堆栈。
  return trimmed.replace(/https?:\/\/\S+/g, "").slice(0, 120) || fallback;
}

/**
 * 内嵌 PNG/JPEG → RGBA，缩放到受控边长内。
 *
 * 不使用 `document` 之外的全局状态；解码失败抛出，由调用方转成可见失败状态。
 */
export async function decodeGlbTexture(
  texture: GlbTexture
): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  if (typeof createImageBitmap !== "function") throw new Error("当前环境不支持图片解码");
  const blob = new Blob([new Uint8Array(texture.bytes)], { type: texture.mimeType });
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, GLB_MAX_TEXTURE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const context = createCanvasContext(width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return {
      width,
      height,
      rgba: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    };
  } finally {
    bitmap.close?.();
  }
}

function createCanvasContext(width: number, height: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 2D 画布");
    return context;
  }
  if (typeof document === "undefined") throw new Error("当前环境不支持图片解码");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 2D 画布");
  return context;
}
