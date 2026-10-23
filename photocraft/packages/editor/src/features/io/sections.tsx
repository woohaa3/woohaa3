import type { FeaturePanelContext } from "../panel-context.js";
import { InterchangePanel } from "./panels.js";

/**
 * 本域的菜单入口（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 域 manifest 只能声明「图像」菜单里的一项：`文件` 菜单的条目来自
 * `EditorDocumentsMenu`（打开/置入/导出 PSD/保存），不由域 manifest 生成。因此
 * 「文件 ▸ 导出为…」与「文件 ▸ Save for Web…」在共享 `PhotoEditorApp` 里装配：它调用
 * 本域的 `requestInterchange({ mode })` 再打开这一节，落点（页签/模式）由本域解释。
 * 三处入口（图像菜单 + 两个文件菜单项）打开的是同一块面板。
 *
 * 注意：新增本节会把 `packages/editor/src/features/boundaries.test.ts` 里
 * 「FEATURE_SECTIONS 唯一 id 数」的断言从 12 改为 13（纯计数，不涉及行为）。
 */
export const sections = [
  {
    id: "interchange",
    order: 12,
    placement: "advanced",
    menu: "图像",
    label: "格式与导出…",
    menuOrder: 3,
    render: ({ controller, locked }: FeaturePanelContext) => (
      <div key="interchange" className="photo-editor__advanced-section" data-advanced-section="interchange">
        <InterchangePanel controller={controller} readonly={locked} />
      </div>
    )
  }
] as const;
