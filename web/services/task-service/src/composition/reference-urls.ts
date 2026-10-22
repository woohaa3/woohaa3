/**
 * 参考输入的对外地址解析（设计稿：docs/diagrams/storage-extension-point.html 的生成链路）。
 *
 * 顺序：
 * ① Provider 有 `uploadReference` 就让它自己上传参考字节（凭据不出插件，返回的地址直接进输入）；
 * ② 不行才调 Media 的 `sign`，由宿主存储按 expose 解析顺序（主存储 presign → 对外后端复制后签名）
 *    签出短期地址。
 *
 * Task 只提出「这个参考要一个外部地址」，不知道存储后端是谁。
 */
import type { CanvasTaskInput, GenerationProvider } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";

/** 读取参考输入字节；由宿主用 `ctx.storage`（media namespace）接上，缺省时不走 ①。 */
export type ReferenceObjectReader = (storageKey: string, scope?: { canvasId: string }) => Promise<{ bytes: Uint8Array; contentType?: string }>;

export type ReferenceUrlResolution = { ok: true; urls: string[] } | { ok: false; reason: string };

export type ReferenceUrlOptions = {
  inputs: readonly CanvasTaskInput[];
  scope?: { canvasId: string };
  provider: GenerationProvider | undefined;
  readReferenceObject?: ReferenceObjectReader | undefined;
  mediaClient?: MediaClient | undefined;
  expiresSeconds: number;
  logger?: ((event: Record<string, unknown>) => void) | undefined;
};

export async function resolveReferenceUrls(options: ReferenceUrlOptions): Promise<ReferenceUrlResolution> {
  const urls: string[] = [];
  for (const input of options.inputs) {
    const uploaded = await uploadWithProvider(input, options);
    if (uploaded !== undefined) {
      urls.push(uploaded);
      continue;
    }
    if (!options.mediaClient) {
      return { ok: false, reason: "任务需要媒体签名能力，但 Media Service 未配置" };
    }
    try {
      urls.push(await options.mediaClient.sign(input.storageKey, options.expiresSeconds, options.scope));
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "参考输入签名失败" };
    }
  }
  return { ok: true, urls };
}

/** ① Provider 自带上传；未实现、返回空或抛错都回落到 expose，只记日志不阻断提交。 */
async function uploadWithProvider(input: CanvasTaskInput, options: ReferenceUrlOptions): Promise<string | undefined> {
  const provider = options.provider;
  if (!provider?.uploadReference || !options.readReferenceObject) return undefined;
  try {
    const object = await options.readReferenceObject(input.storageKey, options.scope);
    const url = await provider.uploadReference({
      reference: {
        role: input.role,
        ...(input.mediaKind ? { mediaKind: input.mediaKind } : {}),
        mediaType: input.mediaType
      },
      bytes: object.bytes,
      contentType: object.contentType ?? input.mediaType,
      // 远端托管 Provider 要把素材写进服务端存储的画布作用域，必须有画布身份。
      ...(options.scope?.canvasId ? { canvasId: options.scope.canvasId } : {}),
      storageKey: input.storageKey
    });
    const trimmed = typeof url === "string" ? url.trim() : "";
    return trimmed === "" ? undefined : trimmed;
  } catch (error) {
    options.logger?.({
      event: "task-upload-reference-failed",
      providerId: provider.providerId,
      storageKey: input.storageKey,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}
