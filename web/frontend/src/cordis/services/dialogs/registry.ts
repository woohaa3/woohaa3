/**
 * Dialog renderer registry（change: add-frontend-dialog-system，任务 1.1 / design D1/D2）。
 *
 * registry 只声明 dialog 的校验与默认策略；业务内容由 renderer 组件在别处注册，
 * 避免 store 依赖 React。
 */
import type { DialogDefinition } from "./types.js";

export class DialogRegistry {
  private readonly definitions = new Map<string, DialogDefinition>();

  /** 注册（或覆盖）一个 dialog 定义；dialogId 必须非空。 */
  register(dialogId: string, definition: DialogDefinition): void {
    if (!dialogId) throw new Error("dialogId 不能为空");
    this.definitions.set(dialogId, definition);
  }

  has(dialogId: string): boolean {
    return this.definitions.has(dialogId);
  }

  /** 注销一个 dialog 定义；返回是否确实移除（change: adopt-frontend-cordis-plugin-runtime）。 */
  unregister(dialogId: string): boolean {
    return this.definitions.delete(dialogId);
  }

  get(dialogId: string): DialogDefinition | null {
    return this.definitions.get(dialogId) ?? null;
  }

  /** 已注册 ID（稳定排序，便于诊断）。 */
  ids(): string[] {
    return [...this.definitions.keys()].sort();
  }

  /**
   * 校验打开请求；未知 ID 或 payload 非法时返回错误（design：拒绝未知 dialog）。
   */
  validate(
    dialogId: string,
    payload: unknown
  ): { ok: true; definition: DialogDefinition } | { ok: false; error: string } {
    const definition = this.definitions.get(dialogId);
    if (!definition) return { ok: false, error: `未注册的 dialog：${dialogId}` };
    const validation = definition.validatePayload(payload);
    if (!validation.ok) return { ok: false, error: `dialog ${dialogId} payload 非法：${validation.error}` };
    return { ok: true, definition };
  }
}

/**
 * 便捷构造：要求 payload 是只含预期字段的对象。
 */
export function objectPayload<T extends Record<string, unknown>>(
  name: string,
  read: (value: Record<string, unknown>) => T | null
): (payload: unknown) => { ok: true; payload: T } | { ok: false; error: string } {
  return (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { ok: false, error: `${name} payload 必须是对象` };
    }
    const result = read(payload as Record<string, unknown>);
    if (!result) return { ok: false, error: `${name} payload 缺少必需字段` };
    return { ok: true, payload: result };
  };
}
