/**
 * 纯 modal stack reducer 与 selectors（change: add-frontend-dialog-system，任务 1.2 / 1.3）。
 *
 * 无 React / DOM 依赖，可直接单测全部转移：
 * - `open` 追加实例；singleton 重复打开时替换 payload；
 * - `replace` 只改 payload，不产生新 instanceId；
 * - `close` 移除目标及其显式子孙；`closeTop` 只移除顶部；
 * - `setBusy` 以 instanceId 校验，忽略迟到结果。
 *
 * 只有顶部实例是活动 modal（design D3）。
 */
import type { DialogInstance, OpenDialogRequest, PayloadValidator } from "./types.js";

export type DialogStack = readonly DialogInstance[];

export type OpenOutcome = {
  stack: DialogStack;
  instance: DialogInstance | null;
  error: string | null;
  /** 本次 open 是否复用了已有 singleton 实例（用于 renderer 重置局部状态）。 */
  replaced: boolean;
};

let sequence = 0;

/** 稳定且每会话唯一的 instanceId。 */
function nextInstanceId(dialogId: string): string {
  sequence += 1;
  return `dialog-${dialogId}-${sequence.toString(36)}`;
}

/**
 * 打开一个实例（reducer 纯函数版本）。
 *
 * `options.singleton` 为真且已存在同类实例时，替换其 payload 并把该实例移到顶部，
 * 不创建第二个实例（design D2：替换 singleton 预览）。
 * `options.validate` 校验 payload；失败时 stack 不变并返回错误。
 */
export function openDialog(
  stack: DialogStack,
  request: OpenDialogRequest,
  options: {
    validate: PayloadValidator;
    dismissible?: boolean;
    singleton?: boolean;
    /** 测试可注入；缺省用递增序列。 */
    makeInstanceId?: (dialogId: string) => string;
  }
): OpenOutcome {
  const validation = options.validate(request.payload);
  if (!validation.ok) {
    return { stack, instance: null, error: validation.error, replaced: false };
  }
  const preferSingleton = request.singleton ?? options.singleton ?? false;
  if (preferSingleton) {
    const index = stack.findIndex((instance) => instance.dialogId === request.dialogId);
    if (index >= 0) {
      const existing = stack[index]!;
      const replaced: DialogInstance = {
        ...existing,
        payload: validation.payload,
        // 替换后重置局部查看状态由 renderer 依据 identity 处理；busy 也要复位。
        busy: false
      };
      const next = [...stack.slice(0, index), ...stack.slice(index + 1), replaced];
      return { stack: next, instance: replaced, error: null, replaced: true };
    }
  }
  const makeInstanceId = options.makeInstanceId ?? nextInstanceId;
  const parent = stack.length > 0 ? stack[stack.length - 1]!.instanceId : null;
  const instance: DialogInstance = {
    instanceId: makeInstanceId(request.dialogId),
    dialogId: request.dialogId,
    payload: validation.payload,
    parentInstanceId: parent,
    dismissible: request.dismissible ?? options.dismissible ?? true,
    busy: false
  };
  return { stack: [...stack, instance], instance, error: null, replaced: false };
}

/** 替换实例 payload；instanceId 为空时作用于顶部。返回新 stack 与是否命中。 */
export function replaceDialog(
  stack: DialogStack,
  payload: unknown,
  instanceId?: string
): { stack: DialogStack; replaced: boolean } {
  const target = instanceId ?? topInstanceId(stack);
  if (!target) return { stack, replaced: false };
  let replaced = false;
  const next = stack.map((instance) => {
    if (instance.instanceId !== target) return instance;
    replaced = true;
    return { ...instance, payload, busy: false };
  });
  return { stack: next, replaced };
}

/**
 * 关闭指定实例及其显式子孙；instanceId 为空时关闭顶部。
 * 子孙通过 `parentInstanceId` 链判定。
 */
export function closeDialog(
  stack: DialogStack,
  instanceId?: string
): { stack: DialogStack; closed: DialogInstance[] } {
  const target = instanceId ?? topInstanceId(stack);
  if (!target) return { stack, closed: [] };
  const removed = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const instance of stack) {
      if (instance.parentInstanceId && removed.has(instance.parentInstanceId) && !removed.has(instance.instanceId)) {
        removed.add(instance.instanceId);
        grew = true;
      }
    }
  }
  const closed = stack.filter((instance) => removed.has(instance.instanceId));
  if (closed.length === 0) return { stack, closed: [] };
  return { stack: stack.filter((instance) => !removed.has(instance.instanceId)), closed };
}

/** 更新 busy；找不到实例时返回原 stack（忽略迟到结果）。 */
export function setDialogBusy(
  stack: DialogStack,
  instanceId: string,
  busy: boolean
): { stack: DialogStack; updated: boolean } {
  let updated = false;
  const next = stack.map((instance) => {
    if (instance.instanceId !== instanceId) return instance;
    updated = true;
    return { ...instance, busy };
  });
  return { stack: updated ? next : stack, updated };
}

/** 顶部实例 ID（空栈为 null）。 */
export function topInstanceId(stack: DialogStack): string | null {
  return stack.length > 0 ? stack[stack.length - 1]!.instanceId : null;
}

/** 顶部实例（空栈为 null）。 */
export function topDialog(stack: DialogStack): DialogInstance | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

/** 当前活动 dialogId（空栈为 null）。 */
export function activeDialogId(stack: DialogStack): string | null {
  return topDialog(stack)?.dialogId ?? null;
}

/** 从根到顶部的 scope path（dialogId 序列）。 */
export function dialogScopePath(stack: DialogStack): string[] {
  return stack.map((instance) => instance.dialogId);
}

/** 是否有 modal 处于活动状态（画布输入门禁，design D6）。 */
export function isModalActive(stack: DialogStack): boolean {
  return stack.length > 0;
}

/** 按 instanceId 查找实例。 */
export function findDialog(stack: DialogStack, instanceId: string): DialogInstance | null {
  return stack.find((instance) => instance.instanceId === instanceId) ?? null;
}
