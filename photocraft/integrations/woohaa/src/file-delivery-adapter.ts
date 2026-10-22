/**
 * 宿主侧文件交付与图片尺寸解码
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.1/3.3 / design D2/D5）。
 *
 * 与 `file-delivery.ts` 的纯下载实现分开：这里把浏览器能力接成编辑器需要的
 * `EditorFilePort`，并给独立文件文档提供“只读尺寸”的有界解码（不做像素合成）。
 */
import type { EditorFilePort } from "@woohaa3/photocraft-editor";
import { startDownload } from "./file-delivery.js";

/**
 * 浏览器下载端口。
 *
 * `baseName` 由文档提供，用于在保存工程/导出 PNG 时得到可区分的文件名；实际文件名由调用方
 * 传入的 `file.fileName` 决定，这里只做兜底替换。
 */
export function createBrowserFilePort(baseName: () => string): EditorFilePort {
  return async (file) => {
    const name = file.fileName && file.fileName.trim() !== "" ? file.fileName : `${baseName() || "photocraft"}.bin`;
    return startDownload({ ...file, fileName: name });
  };
}

/**
 * 读取图片源尺寸（不保留位图）。
 *
 * 独立文件文档在打开编辑器前需要源尺寸来建立适合窗口的取景；解码后立即释放位图。
 * 失败返回 null（由呈现层给出可读原因）。
 */
export async function decodeImageSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const bitmap = await createImageBitmap(new Blob([copy], { type: "image/png" }), { imageOrientation: "from-image" });
  try {
    if (!bitmap.width || !bitmap.height) return null;
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
