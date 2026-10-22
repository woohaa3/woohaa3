/**
 * 设置编辑状态上报 hook（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.3 / design D4）。
 *
 * 设置工作区的每个编辑面（设置行、插件详情里的刷新动作、扩展自带面板）都通过它把
 * 「未保存草稿 / 写请求进行中」汇入同一 edit-session，使关闭、切分区与返回列表共用一套门禁。
 *
 * 只在 effect 中上报：渲染阶段不写外部状态，避免在别的组件渲染中触发订阅通知。
 */
import { useEffect, useRef } from "react";
import type { SettingsEditRegistration, SettingsEditSession } from "../edit-session.js";

export type SettingsEditReport = { dirty: boolean; pending: boolean };

export function useSettingsEditReport(
  editSession: SettingsEditSession | undefined,
  id: string,
  state: SettingsEditReport
): void {
  const registration = useRef<SettingsEditRegistration | null>(null);

  // 注册只在会话/身份变化时重建；卸载即注销（不会在旧实例上留下状态）。
  useEffect(() => {
    if (!editSession) return undefined;
    const created = editSession.register({ id });
    registration.current = created;
    return () => {
      created.dispose();
      if (registration.current === created) registration.current = null;
    };
  }, [editSession, id]);

  // 状态变化只上报，不重建注册。
  useEffect(() => {
    registration.current?.report(state);
  }, [editSession, id, state.dirty, state.pending]);
}
