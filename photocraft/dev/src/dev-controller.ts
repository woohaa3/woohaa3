/**
 * dev 宿主的控制器装配
 * （change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
 *
 * 把「一个文档槽位需要哪些端口」从 JSX 里抽出来，是为了让「端口真的被注入」这件事可断言。
 * 此前这个对象内联在 `PhotoCraftDevApp` 里，测试只能自己再造一个 controller —— 于是
 * 「宿主忘了注入 `fileDelivery`」这类缺陷测不出来（用例全绿，界面点不动）。
 *
 * 端口清单：
 * - `session`：本机保存基线（工程保存推进，导出 PNG 不推进）；
 * - `fileDelivery`：本地文件交付（文件 ▸ 导出 PNG…）；只报 `download-started`；
 * - `save`：节点保存（dev 里成对下载工程 + PNG）；
 * - `assetUrl`：dev 的 public 根是 `photocraft/assets`，字体在 `/fonts/...`；
 * - `dialogOwner`：只在控制器空闲时提供可信 owner（命名弹窗归属）。
 */
import {
  EditorWorkspaceController,
  type EditorFilePort,
  type EditorWorkspaceOptions
} from "@woohaa3/photocraft-editor";
import { createDevFileDelivery, exportFileName, type DevDeliveryEnvironment } from "./dev-delivery.js";
import type { DevDocumentSession } from "./dev-session.js";
import type { DevDocumentSlot } from "./dev-workspace.js";

/** 下载动作（工程 + PNG 成对交付时用；与端口内的下载共用同一实现由调用方注入）。 */
export type DevDownload = (bytes: Uint8Array, name: string, type: string) => void;

export type DevControllerOptions = {
  session: DevDocumentSession;
  slot: DevDocumentSlot;
  /** 成对下载实现（`save` 端口用）。 */
  download: DevDownload;
  /**
   * 当前文档名（含扩展名）。
   *
   * 传 getter 而不是值：控制器在文档打开前就创建好了，保存时才需要名字。有了它，dev 的保存
   * 与 Woohaa 一致按文档名命名（`sample.png` → `sample.pcraft` / `sample.png`），
   * 而不是固定写 `photocraft-A.*`。
   */
  documentName?: () => string | null | undefined;
  /** 文件交付端口的环境；缺省取浏览器能力（测试可注入替身）。 */
  deliveryEnvironment?: DevDeliveryEnvironment | null;
  /** 文件交付端口；缺省由 `deliveryEnvironment` 构造。 */
  fileDelivery?: EditorFilePort;
};

/** dev 宿主的控制器选项（导出后可直接断言端口是否注入）。 */
export function devControllerOptions(options: DevControllerOptions): EditorWorkspaceOptions {
  const { session, slot, download, documentName } = options;
  const fileDelivery = options.fileDelivery
    ?? createDevFileDelivery(options.deliveryEnvironment === undefined ? undefined : options.deliveryEnvironment);
  return {
    session,
    dialogOwner: () => ({ canvasId: "dev", nodeId: `dev-image-${slot}`, sessionId: `dev-session-${slot}` }),
    // dev 的 public 根是 `photocraft/assets`：字体在 `/fonts/...`，不是宿主的 `/assets/fonts/...`。
    assetUrl: (path) => path.replace(/^\/assets\//, "/"),
    // 缺了这个端口，「文件 ▸ 导出 PNG…」会恒返回「当前宿主不支持本地文件保存」。
    fileDelivery,
    save: async ({ artifacts, isCurrent }) => {
      if (!isCurrent()) return { ok: false, code: "closed", message: "编辑会话已结束", retriable: false };
      // 与「导出 PNG…」共用同一套文件名推导，避免工程与图片扩展名重复（`sample.png.png`）。
      download(artifacts.project, exportFileName(documentName?.(), "pcraft"), "application/octet-stream");
      download(artifacts.output, exportFileName(documentName?.(), "png"), "image/png");
      return { ok: true };
    }
  };
}

/** 按槽位创建控制器（`PhotoCraftDevApp` 唯一入口）。 */
export function createDevController(options: DevControllerOptions): EditorWorkspaceController {
  return new EditorWorkspaceController(devControllerOptions(options));
}
