/**
 * 设置弹窗的外壳：共享 Dialog primitives + 设置专属布局类
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 2.1 / design D2）。
 *
 * 只负责一张大弹窗的结构：固定 Header（标题 + 关闭）与左栏/右栏两列布局；右栏正文是唯一
 * 滚动容器。尺寸用设置专属 class（`.settings-dialog`），不改所有 `lg` 弹窗宽度。
 *
 * 关闭只经 `onRequestClose`（Host 的 guard 通路）：本组件不监听 Escape/遮罩，也不直接调用
 * Dialog Service，保证 dirty 确认、busy 拒绝与 forced dispose 共用一条路径。
 */
import type { ReactNode } from "react";
import { Dialog } from "../../../services/dialogs/Dialog.js";

export const SETTINGS_DIALOG_ID = "settings";
export const SETTINGS_DIALOG_TITLE_ID = `${SETTINGS_DIALOG_ID}-title`;

export function SettingsDialogChrome({
  nav,
  children,
  onRequestClose,
  instanceId,
  section
}: {
  /** 左侧分区导航（固定，不随正文滚动）。 */
  nav: ReactNode;
  /** 右栏正文（唯一滚动区）。 */
  children: ReactNode;
  onRequestClose: () => void;
  instanceId?: string;
  /** 当前分区（仅供样式/测试定位，不参与状态）。 */
  section?: string;
}) {
  return (
    <Dialog.Content
      variant="standard"
      size="lg"
      className="settings-dialog"
      labelledBy={SETTINGS_DIALOG_TITLE_ID}
      {...(instanceId ? { instanceId } : {})}
      onOverlayClick={onRequestClose}
    >
      <Dialog.Header onClose={onRequestClose} closeLabel="关闭设置">
        <Dialog.Title id={SETTINGS_DIALOG_TITLE_ID}>设置</Dialog.Title>
        <Dialog.Description>配置核心服务、插件与外观。关闭不会刷新页面或重启宿主。</Dialog.Description>
      </Dialog.Header>
      <div className="settings-workbench">
        {nav}
        <div className="settings-workbench__body" data-testid="settings-workspace" {...(section ? { "data-section": section } : {})}>
          {children}
        </div>
      </div>
    </Dialog.Content>
  );
}
