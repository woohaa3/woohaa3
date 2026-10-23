/**
 * 独立开发宿主的本地交付端口
 * （change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4 的宿主部分）。
 *
 * 为什么需要它：`EditorWorkspaceController.deliverFile()` 只在**注入了** `fileDelivery` 时工作，
 * 否则一律返回「当前宿主不支持本地文件保存」。此前 dev 宿主只配了节点保存端口（`save`），
 * 于是「文件 ▸ 导出 PNG…」永远失败，而菜单项看起来是可用的 —— 典型的「菜单存在但功能不可用」。
 *
 * 与 Woohaa 适配包的 `createBrowserFilePort` 语义一致：
 * - 只能发起浏览器下载，因此结果**永远**是 `download-started`，绝不上报 `written`
 *   （那会推进保存基线、清除未保存状态，等于谎称已落盘）；
 * - 空文件名或空字节明确失败，不产生 0 字节的「交付」；
 * - 环境不支持（无 DOM / 无 `URL.createObjectURL`）时返回失败原因，而不是静默什么都不做。
 *
 * DOM 依赖经 `DevDeliveryEnvironment` 注入，纯逻辑因此可在 node 下测试。
 */
import type { EditorFileDeliveryResult, EditorFilePort } from "@woohaa3/photocraft-editor";

export type DevDeliveryEnvironment = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** 触发下载；文件名由调用方给出，浏览器不得改写内容。 */
  trigger(url: string, fileName: string): void;
};

/** 浏览器环境（node / 缺少对象 URL 时返回 null，由端口给出明确失败原因）。 */
export function browserDeliveryEnvironment(): DevDeliveryEnvironment | null {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    trigger: (url, fileName) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      anchor.click();
    }
  };
}

/**
 * 由文档名推导交付文件名：去掉原有扩展名再加目标扩展名。
 *
 * 真实缺陷：`document.name` 已经是 `sample.png`，直接拼 `.png` 会交付成 `sample.png.png`。
 * Woohaa 宿主一直先剥扩展名，两个宿主不该给出不同的文件名。
 */
export function exportFileName(documentName: string | null | undefined, extension: string): string {
  const base = (documentName ?? "").trim().replace(/\.[^.\\/]+$/, "") || "photocraft";
  return `${base}.${extension}`;
}

/**
 * 把交付结果翻译成界面提示。
 *
 * 为什么要单独一个函数：`deliverFile()` 有四种结果（写入 / 已发起下载 / 取消 / 失败），
 * 早先 dev 宿主直接 `void deliverFile(...)` 丢掉结果，失败时界面**什么都不显示**，
 * 用户只会觉得「点了没反应」。把映射抽出来，四种结果都能被断言。
 */
export function exportOutcomeMessage(outcome: EditorFileDeliveryResult, fileName: string): string {
  if (outcome.ok) {
    // 只有 `written` 才代表真的落盘；浏览器下载只能算「已发起」。
    return outcome.status === "download-started"
      ? `已发起下载：${fileName}（下载不等于已保存工程）`
      : `已导出：${fileName}（不影响工程保存状态）`;
  }
  if (outcome.status === "cancelled") return "已取消导出，文档保留";
  return outcome.message || "导出失败";
}

/**
 * 创建 dev 宿主的文件交付端口。
 *
 * 传给 `EditorWorkspaceController({ fileDelivery })` 后，「文件 ▸ 导出 PNG…」与
 * 面板里的导出都能真正发起下载。
 */
export function createDevFileDelivery(environment: DevDeliveryEnvironment | null = browserDeliveryEnvironment()): EditorFilePort {
  return async (file) => {
    if (!file.fileName.trim()) return { ok: false, status: "failed", message: "缺少交付文件名" };
    if (file.bytes.length === 0) return { ok: false, status: "failed", message: "交付内容为空，未发起下载" };
    if (!environment) return { ok: false, status: "failed", message: "当前环境不支持浏览器下载" };
    let url: string | null = null;
    try {
      // 复制字节：调用方后续修改不能影响已发起的内容。
      url = environment.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.contentType }));
      environment.trigger(url, file.fileName);
    } catch (error) {
      return { ok: false, status: "failed", message: error instanceof Error ? error.message : "下载失败" };
    } finally {
      // 下载已由浏览器接管；释放 URL 不撤销正在进行的下载。只释放一次（成功与失败同一路径）。
      if (url) environment.revokeObjectURL(url);
    }
    return { ok: true, status: "download-started" };
  };
}
