/**
 * AlertDialog 注册与异步确认（change: add-frontend-dialog-system，任务 2.3 / 5.x）。
 *
 * store 不保存业务闭包：payload 只携带可序列化字段与一个 `actionKey`；真正的异步
 * 业务动作由调用方在 `alertActionRegistry` 里按 key 注册（Host/业务模块拥有，
 * store 生命周期与其解耦，避免不可预测的闭包引用）。
 */
import { objectPayload } from "./registry.js";
import type { DialogDefinition } from "./types.js";

export const ALERT_DIALOG_ID = "alert";

export type AlertPayload = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 异步确认动作 key；Host 查 `alertActionRegistry` 得到实际回调。 */
  actionKey?: string;
};

export type AlertActionResult = { ok: true } | { ok: false; error: string };
export type AlertAction = () => Promise<AlertActionResult>;

const actions = new Map<string, AlertAction>();

/** 注册一个异步确认动作；返回注销函数。 */
export function registerAlertAction(key: string, action: AlertAction): () => void {
  if (!key) throw new Error("actionKey 不能为空");
  actions.set(key, action);
  return () => {
    if (actions.get(key) === action) actions.delete(key);
  };
}

export function resolveAlertAction(key: string | undefined): AlertAction | null {
  if (!key) return null;
  return actions.get(key) ?? null;
}

export const alertDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  validatePayload: objectPayload<AlertPayload>("alert", (value) => {
    const title = value.title;
    const description = value.description;
    if (typeof title !== "string" || title === "") return null;
    if (typeof description !== "string" || description === "") return null;
    return {
      title,
      description,
      confirmLabel: typeof value.confirmLabel === "string" ? value.confirmLabel : undefined,
      cancelLabel: typeof value.cancelLabel === "string" ? value.cancelLabel : undefined,
      danger: value.danger === true,
      actionKey: typeof value.actionKey === "string" ? value.actionKey : undefined
    };
  })
};
