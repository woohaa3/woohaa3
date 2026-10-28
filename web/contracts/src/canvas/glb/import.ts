/**
 * GLB 文件模型的导入/下载事实（change: 2026-10-28-support-glb-model-nodes）。
 *
 * 纯函数、无 I/O：供上传分类、下载回原始文件与测试共用。`.gltf`（JSON + 外部资源）不在
 * 支持范围内，因此只有 `.glb` / `model/gltf-binary` 会被识别为文件模型。
 */

/** 文件模型的规范 MIME。 */
export const GLB_MEDIA_TYPE = "model/gltf-binary" as const;
/** 文件模型扩展名（含点）。 */
export const GLB_FILE_EXTENSION = ".glb" as const;

/** 资产 metadata 中记录模型格式的键（下载时据此恢复 `.glb` 文件名）。 */
export const MODEL_FORMAT_METADATA_KEY = "modelFormat" as const;
export const GLB_MODEL_FORMAT = "glb" as const;

/**
 * 是否为受支持的 GLB 文件。
 *
 * 浏览器对 `.glb` 常给出空 MIME 或 `application/octet-stream`，因此扩展名优先；MIME 只作为
 * 辅助判据。`.gltf` 一律不接受。
 */
export function isGlbFile(file: { name?: string; type?: string }): boolean {
  const name = (file.name ?? "").trim().toLowerCase();
  if (name.endsWith(GLB_FILE_EXTENSION)) return true;
  if (name.endsWith(".gltf")) return false;
  const type = (file.type ?? "").split(";")[0].trim().toLowerCase();
  return type === GLB_MEDIA_TYPE;
}

/** 上传/下载使用的 MIME：浏览器未提供时收敛到规范 `model/gltf-binary`。 */
export function glbContentType(file: { type?: string }): string {
  const type = (file.type ?? "").split(";")[0].trim().toLowerCase();
  return type === GLB_MEDIA_TYPE ? type : GLB_MEDIA_TYPE;
}

/** 资产是否为 GLB 文件模型（nodeData 引用 + 资产 metadata 双重判据）。 */
export function isGlbAssetMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata[MODEL_FORMAT_METADATA_KEY] === GLB_MODEL_FORMAT) return true;
  const contentType = metadata.contentType;
  return typeof contentType === "string"
    && contentType.split(";")[0].trim().toLowerCase() === GLB_MEDIA_TYPE;
}
