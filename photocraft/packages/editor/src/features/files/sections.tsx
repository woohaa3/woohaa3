import type { FeaturePanelContext } from "../panel-context.js";
import {
  DocumentCopyPanel,
  FileInfoPanel,
  NewDocumentWorkspace
} from "./panels.js";
import { canCreateInSession } from "./model.js";

/**
 * 本域菜单/高级面板入口（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 位置说明：共享 chrome 的「文件」菜单目前只渲染宿主文档动作，不消费
 * `featureMenuSections("文件")`；因此本域暂以 `advanced` 入口挂载，等共享 chrome 提供文件菜单
 * 槽位与弹窗端口后再迁移，不在这里改共享文件或伪造菜单项。
 *
 * 新建只在**没有**活动文档的候选实例上成立（一个编辑会话一个文档槽位）：当前实例已有文档时
 * 直接说明原因，而不是让用户点击后再吃一次内核拒绝。
 *
 * 「新建」与「预设/最近」共用一个入口：两者必须读写同一份表单设置，否则「保存当前设置」
 * 拿不到设置、「使用预设」也填不回新建表单（见 `NewDocumentWorkspace`）。
 */
export const sections = [
  {
    id: "filesNewDocument",
    order: 20,
    placement: "advanced",
    menu: "文件",
    label: "新建文档、预设与最近…",
    menuOrder: 20,
    render: ({ controller, readonly, requestDocumentSlot, documentView, recentFiles, recentFilesError, reopenRecent, removeRecent, hasRecentBytes, applyExportPreset, documentBusy }: FeaturePanelContext) => {
      // 宿主提供独立文档槽位时，「已有文档」不再是禁用理由：新建会产出字节交给宿主另开标签。
      const slot = requestDocumentSlot ? { ok: true as const } : canCreateInSession(!!documentView);
      return (
        <div key="filesNewDocument" className="photo-editor__advanced-section" data-advanced-section="filesNewDocument">
          <NewDocumentWorkspace
            controller={controller}
            readonly={readonly}
            disabledReason={slot.ok ? null : slot.reason}
            onRequestDocumentSlot={requestDocumentSlot}
            {...(recentFiles === undefined ? {} : { recentIndex: recentFiles })}
            {...(recentFilesError ? { recentStorageError: recentFilesError } : {})}
            {...(reopenRecent ? { onReopenRecent: reopenRecent } : {})}
            {...(removeRecent ? { onRemoveRecent: removeRecent } : {})}
            {...(hasRecentBytes ? { hasRecentBytes } : {})}
            {...(applyExportPreset ? { onUseExportPreset: applyExportPreset } : {})}
            {...(documentBusy === undefined ? {} : { documentBusy })}
          />
        </div>
      );
    }
  },
  {
    id: "filesCopy",
    order: 21,
    placement: "advanced",
    menu: "文件",
    label: "文档副本与恢复…",
    menuOrder: 21,
    render: ({ controller, locked }: FeaturePanelContext) => (
      <div key="filesCopy" className="photo-editor__advanced-section" data-advanced-section="filesCopy">
        <DocumentCopyPanel controller={controller} readonly={locked} />
      </div>
    )
  },
  {
    id: "filesFileInfo",
    order: 22,
    placement: "advanced",
    menu: "文件",
    label: "文件信息…",
    menuOrder: 22,
    render: ({ controller, locked }: FeaturePanelContext) => (
      <div key="filesFileInfo" className="photo-editor__advanced-section" data-advanced-section="filesFileInfo">
        <FileInfoPanel controller={controller} readonly={locked} />
      </div>
    )
  }
] as const;
