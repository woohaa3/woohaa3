/**
 * 本地文件交付（浏览器下载）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.3 / design D5）。
 *
 * Woohaa 浏览器宿主没有“可信写入磁盘”的原生文件端口：交付只能通过浏览器下载完成。
 * 因此这里**只**返回 `download-started`，绝不宣称目标磁盘已写入，也不清除未保存状态；
 * 关闭/离开时由用户显式「确认已保存并关闭」或「不保存」。
 *
 * Tauri 宿主若将来有已实现且可信的文件保存端口，替换本函数即可；本期不引入新的原生文件权限。
 */
import type { EditorFileDelivery, EditorFileDeliveryResult, EditorFilePort } from "@woohaa3/photocraft-editor";

/** 是否可以用浏览器下载（无 DOM/Blob 环境返回 false，例如 jsdom 精简环境）。 */
export function canStartDownload(): boolean {
  return typeof document !== "undefined"
    && typeof URL !== "undefined"
    && typeof URL.createObjectURL === "function"
    && typeof Blob !== "undefined";
}

/**
 * 发起一次浏览器下载。
 *
 * 返回 `download-started` 表示已把文件交给浏览器；用户取消保存对话框、磁盘写满或浏览器拦截
 * 都发生在下载启动之后，宿主无法区分，因此不推进保存基线。
 */
export function startDownload(file: EditorFileDelivery): EditorFileDeliveryResult {
  if (!canStartDownload()) {
    return { ok: false, status: "failed", message: "当前环境不支持下载文件" };
  }
  try {
    const copy = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([copy], { type: file.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 下载已由浏览器接管；释放 URL 不撤销正在进行的下载。
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, status: "download-started" };
  } catch (error) {
    return { ok: false, status: "failed", message: error instanceof Error ? error.message : "无法开始下载" };
  }
}

/** 适配为编辑器可消费的 `EditorFilePort`。 */
export const browserDownloadPort: EditorFilePort = async (file) => startDownload(file);
