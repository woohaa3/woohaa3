/**
 * Dialog Host store（change: add-frontend-dialog-system，任务 1.1 / 3.1 / design D2）。
 *
 * 宿主级弹窗的**唯一有序状态源**：保存类型化 descriptor，暴露 open/replace/close/
 * closeTop/setBusy。App 与业务组件不得为已注册弹窗维护第二套权威 open stack。
 *
 * 无 React 依赖：用与 `nodeSelectionStore` 一致的轻量订阅模式，供 `useSyncExternalStore`
 * 消费。状态是可丢弃的瞬时 UI，不写 Y.Doc / IndexedDB / URL（design D7）。
 */
import {
  activeDialogId as selectActiveDialogId,
  closeDialog,
  dialogScopePath,
  findDialog,
  isModalActive as selectIsModalActive,
  openDialog,
  replaceDialog,
  setDialogBusy,
  topDialog,
  type DialogStack
} from "./stack.js";
import { type DialogRegistry } from "./registry.js";
import type {
  DialogCloseGuard,
  DialogCloseResult,
  DialogHostApi,
  DialogInstance,
  DialogOpenParticipant,
  OpenDialogRequest,
  OpenDialogResult
} from "./types.js";

export type DialogHostSnapshot = {
  stack: DialogStack;
  activeDialogId: string | null;
  isModalActive: boolean;
  scopePath: string[];
};

const EMPTY: DialogHostSnapshot = {
  stack: [],
  activeDialogId: null,
  isModalActive: false,
  scopePath: []
};

export type DialogHostListener = (snapshot: DialogHostSnapshot) => void;

export class DialogHostStore implements DialogHostApi {
  private snapshot: DialogHostSnapshot = EMPTY;
  private readonly listeners = new Set<DialogHostListener>();
  /** 开发期诊断：最近一次被拒绝的打开请求。 */
  private lastDiagnostic: string | null = null;
  /** open pre-commit participants（change: unify-canvas-presentation-navigation）。 */
  private readonly openParticipants = new Set<DialogOpenParticipant>();
  /** 关闭请求 guard（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2）。 */
  private readonly closeGuards = new Map<string, DialogCloseGuard>();

  /**
   * `registry` 必填：每个 Dialog Service/scoped 实例持有自己的定义表，避免全局单例。
   * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，B06。）
   */
  constructor(private readonly registry: DialogRegistry) {}

  /** 暴露绑定的定义表，供 facade 复用（change: adopt-frontend-cordis-plugin-runtime）。 */
  registryRef(): DialogRegistry {
    return this.registry;
  }

  getSnapshot = (): DialogHostSnapshot => this.snapshot;

  subscribe = (listener: DialogHostListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 最近一次拒绝诊断（未知 dialog / payload 非法），供测试与开发期提示。 */
  getDiagnostic(): string | null {
    return this.lastDiagnostic;
  }

  open(request: OpenDialogRequest): OpenDialogResult {
    // 1) 纯校验（registration / payload / stack plan）。未知 dialog、非法 payload 不运行 cleanup。
    const validation = this.registry.validate(request.dialogId, request.payload);
    if (!validation.ok) {
      this.lastDiagnostic = validation.error;
      return { ok: false, error: validation.error };
    }
    const outcome = openDialog(this.snapshot.stack, request, {
      validate: validation.definition.validatePayload,
      dismissible: validation.definition.dismissible,
      singleton: validation.definition.singleton
    });
    if (outcome.error || !outcome.instance) {
      this.lastDiagnostic = outcome.error ?? "打开失败";
      return { ok: false, error: outcome.error ?? "打开失败" };
    }
    const editingOwner = validation.definition.editingOwner?.();
    if (validation.definition.editingOwner && !editingOwner) {
      this.lastDiagnostic = "当前图片编辑会话已失效或仍有未完成操作，请结束操作后重试";
      return { ok: false, error: this.lastDiagnostic };
    }
    // 2) 纯校验通过后运行 pre-commit participants（关闭 menu/panel、释放 input/session）。
    if (!this.runOpenParticipants(request, editingOwner ?? undefined)) {
      this.lastDiagnostic = "dialog open participant 拒绝或失败";
      return { ok: false, error: this.lastDiagnostic };
    }
    // 3) 一次提交 stack。
    this.lastDiagnostic = null;
    this.applyStack(outcome.stack);
    return { ok: true, instance: outcome.instance };
  }

  /** 注册 open pre-commit participant；返回注销函数。 */
  registerOpenParticipant(participant: DialogOpenParticipant): () => void {
    this.openParticipants.add(participant);
    return () => {
      this.openParticipants.delete(participant);
    };
  }

  private runOpenParticipants(request: OpenDialogRequest, editingOwner?: import("./types.js").DialogEditingOwner): boolean {
    for (const participant of this.openParticipants) {
      try {
        if (!participant({ dialogId: request.dialogId, payload: request.payload, ...(editingOwner ? { editingOwner } : {}) })) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  replace(payload: unknown, instanceId?: string): boolean {
    const result = replaceDialog(this.snapshot.stack, payload, instanceId);
    if (result.replaced) this.applyStack(result.stack);
    return result.replaced;
  }

  close(instanceId?: string): boolean {
    const result = closeDialog(this.snapshot.stack, instanceId);
    if (result.closed.length === 0) return false;
    this.applyStack(result.stack);
    return true;
  }

  closeTop(): boolean {
    return this.close();
  }

  setBusy(instanceId: string, busy: boolean): boolean {
    const result = setDialogBusy(this.snapshot.stack, instanceId, busy);
    if (result.updated) this.applyStack(result.stack);
    return result.updated;
  }

  /** 由 Host 组件在事件/确认处理里读取当前顶部实例。 */
  top(): DialogInstance | null {
    return topDialog(this.snapshot.stack);
  }

  find(instanceId: string): DialogInstance | null {
    return findDialog(this.snapshot.stack, instanceId);
  }

  /**
   * 请求关闭顶部（Escape / 遮罩 / 关闭按钮统一入口）。
   * `dismissible: false` 或 `busy: true` 时拒绝（design D5）。
   * 返回 `instanceId` 便于调用方判断是否发生了关闭。
   */
  requestCloseTop(): DialogCloseResult {
    return this.requestClose();
  }

  /**
   * 请求关闭指定实例（缺省顶部）：Escape / 遮罩 / Header 关闭按钮 / 业务关闭共用入口。
   *
   * 判定顺序：top identity → dismissible → busy → 已注册的 close guard。
   * guard 返回 `handled` 时本次请求不关闭（由 guard 自行决定后续动作）。
   */
  requestClose(instanceId?: string): DialogCloseResult {
    const top = this.top();
    if (!top) return { closed: false, instanceId: null };
    const target = instanceId ?? top.instanceId;
    if (target !== top.instanceId) return { closed: false, instanceId: target };
    if (!top.dismissible || top.busy) return { closed: false, instanceId: top.instanceId };
    const guard = this.closeGuards.get(top.dialogId);
    if (guard) {
      let outcome: "allow" | "handled" = "allow";
      try {
        outcome = guard(top);
      } catch {
        // guard 失败时保守拒绝关闭：宁可留在当前视图，也不要丢掉草稿。
        outcome = "handled";
      }
      if (outcome === "handled") return { closed: false, instanceId: top.instanceId, handled: true };
    }
    const ok = this.close(top.instanceId);
    return { closed: ok, instanceId: top.instanceId };
  }

  /** 注册关闭请求 guard；返回注销函数。 */
  registerCloseGuard(dialogId: string, guard: DialogCloseGuard): () => void {
    this.closeGuards.set(dialogId, guard);
    return () => {
      if (this.closeGuards.get(dialogId) === guard) this.closeGuards.delete(dialogId);
    };
  }

  /** 测试/回滚用：清空 stack。 */
  reset(): void {
    this.applyStack([]);
  }

  private applyStack(stack: DialogStack): void {
    const next: DialogHostSnapshot = {
      stack,
      activeDialogId: selectActiveDialogId(stack),
      isModalActive: selectIsModalActive(stack),
      scopePath: dialogScopePath(stack)
    };
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
  }
}
