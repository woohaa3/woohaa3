/**
 * Dialog renderer 类型（change: add-frontend-dialog-system，任务 3.1 / design D1）。
 *
 * 业务功能通过 `DialogService.registerDialog` 按 `dialogId` 注册 React renderer；Dialog Host
 * 只按注入 Service 的 renderer 查找渲染，store 本身不持有 ReactNode 或业务闭包（design D2）。
 * 旧的模块级全局 renderer map 已删除（change: 2026-10-09-...，B06）。
 */
import type { ComponentType } from "react";
import type { DialogInstance } from "./types.js";

/** renderer 可用的关闭/busy 能力（由 Host 注入）。 */
export type DialogRendererProps = {
  instance: DialogInstance;
  /** 请求关闭当前实例（遵循 close policy）。 */
  requestClose: () => void;
  /** 标记 busy。 */
  setBusy: (busy: boolean) => void;
  /** 替换当前实例 payload。 */
  replace: (payload: unknown) => void;
};

export type DialogRenderer = ComponentType<DialogRendererProps>;
