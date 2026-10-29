/**
 * 设置弹窗的外壳：共享 Dialog primitives + 设置专属布局类
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 2.1 / design D2）。
 *
 * 只负责一张大弹窗的结构：左侧轨道（品牌 + 关闭 + 分区导航 + 本机状态）与右侧正文；
 * 右侧正文是唯一滚动容器。尺寸用设置专属 class（`.settings-dialog`），不改所有 `lg` 弹窗宽度。
 *
 * 关闭只经 `onRequestClose`（Host 的 guard 通路）：本组件不监听 Escape/遮罩，也不直接调用
 * Dialog Service，保证 dirty 确认、busy 拒绝与 forced dispose 共用一条路径。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@woohaa3/ui/dialogs";

export const SETTINGS_DIALOG_ID = "settings";
export const SETTINGS_DIALOG_TITLE_ID = `${SETTINGS_DIALOG_ID}-title`;

export function SettingsDialogChrome({
  nav,
  children,
  onRequestClose,
  instanceId,
  section,
  level,
  motion
}: {
  /** 左侧导航（固定，不随正文滚动）；随层级切换整块替换。 */
  nav: ReactNode;
  /** 右栏正文（唯一滚动区）。 */
  children: ReactNode;
  onRequestClose: () => void;
  instanceId?: string;
  /** 当前分区（仅供样式/测试定位，不参与状态）。 */
  section?: string;
  /** 当前层级：0 分区 / 1 插件概览 / 2 插件子页。只影响样式与动效。 */
  level?: 0 | 1 | 2;
  /** 进行中的层级平移方向；动效期间左右栏不接受点击。 */
  motion?: "forward" | "back" | "sibling" | null;
}) {
  const [scrolling, setScrolling] = useState(false);
  const scrollEnd = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scrollEnd.current) clearTimeout(scrollEnd.current);
    };
  }, []);

  const handleScroll = () => {
    setScrolling(true);
    if (scrollEnd.current) clearTimeout(scrollEnd.current);
    scrollEnd.current = setTimeout(() => setScrolling(false), 700);
  };

  return (
    <Dialog.Content
      variant="standard"
      size="lg"
      className="settings-dialog"
      labelledBy={SETTINGS_DIALOG_TITLE_ID}
      {...(instanceId ? { instanceId } : {})}
      onOverlayClick={onRequestClose}
    >
      <div
        className="settings-workbench"
        data-level={level ?? 0}
        {...(motion ? { "data-motion": motion } : {})}
      >
        <aside className="settings-rail">
          <div className="settings-rail__brand">
            <Dialog.Header onClose={onRequestClose} closeLabel="关闭设置">
              <Dialog.Title id={SETTINGS_DIALOG_TITLE_ID}>设置</Dialog.Title>
              <Dialog.Description>本机工作区</Dialog.Description>
            </Dialog.Header>
          </div>
          {nav}
        </aside>
        <div className="settings-main">
          <div
            className={scrolling ? "settings-workbench__body is-scrolling" : "settings-workbench__body"}
            data-testid="settings-workspace"
            onScroll={handleScroll}
            {...(section ? { "data-section": section } : {})}
          >
            {children}
          </div>
        </div>
      </div>
    </Dialog.Content>
  );
}
