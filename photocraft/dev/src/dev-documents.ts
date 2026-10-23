/**
 * dev 宿主的「文件」菜单装配
 * （change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
 *
 * 为什么单独成函数：这段回调以前内联在 JSX 里，只能靠浏览器手工点。结果是两个真实缺陷
 * 都没被自动化抓到——
 *
 * 1. `onSave` 写成 `() => { void apply(); }`，返回 `undefined`，共享层的 `await save()`
 *    立刻完成，保存失败变成未处理的 rejection，界面一片空白；
 * 2. `onExportPng` 丢弃 `deliverFile()` 的返回值，缺端口/取消/失败全都不出声。
 *
 * 抽出来之后，「保存真的返回 Promise」「导出真的落到交付端口且把结果说出来」都能在 node 下断言。
 * 菜单条目的顺序与文案仍由共享 `editorMenusFor` 决定，这里只提供能力回调。
 */
import type { EditorDocumentsMenu, EditorWorkspaceController } from "@woohaa3/photocraft-editor";
import { exportFileName, exportOutcomeMessage } from "./dev-delivery.js";
import type { DevDocumentSlot, SlotState } from "./dev-workspace.js";

export type DevDocumentsInput = {
  /** 当前活动文档的控制器（导出/保存都打到它）。 */
  controller: EditorWorkspaceController;
  /** 文档名（含扩展名）；交付文件名由它推导。 */
  documentName: string | null | undefined;
  /** 保存：必须返回 Promise，失败由共享层捕获并提示。 */
  save: () => Promise<void>;
  /** 打开文件对话框。 */
  openFile: () => void;
  /** 已打开的文档槽位。 */
  slots: readonly SlotState[];
  activeSlot: DevDocumentSlot;
  /** 切换文档；拒绝（存在未结算草稿）时返回 false。 */
  activate: (slot: DevDocumentSlot) => boolean;
  /** 交付结果反馈。 */
  report: (message: string) => void;
  /** 工作区剪贴板（与文档菜单同一入口）。 */
  transfer?: EditorDocumentsMenu["transfer"];
};

/** 组装 dev 宿主交给共享菜单栏的文档菜单能力。 */
export function devDocumentsMenu(input: DevDocumentsInput): EditorDocumentsMenu {
  const { controller, documentName, save, openFile, slots, activeSlot, activate, report, transfer } = input;
  return {
    ...(transfer ? { transfer } : {}),
    saveLabel: "保存",
    // 返回 Promise 而不是 `void`：`applySave` 靠 `await save()` 捕获失败。
    onSave: save,
    onOpenFile: openFile,
    onExportPng: () => {
      void (async () => {
        const fileName = exportFileName(documentName, "png");
        const outcome = await controller.deliverFile("png", { fileName });
        report(exportOutcomeMessage(outcome, fileName));
      })();
    },
    list: slots
      .filter((slot) => slot.open)
      .map((slot) => ({
        id: slot.slot,
        name: `${slot.slot} · ${slot.name || "未命名"}`,
        active: slot.slot === activeSlot
      })),
    onActivateDocument: (id) => {
      activate(id as DevDocumentSlot);
    }
  };
}
