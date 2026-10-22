/**
 * 独立宿主的受控对话框端口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3）。
 *
 * 演示并验证编辑器的 `EditorDialogPort`：编辑器只注册 renderer 与请求打开/关闭，弹窗栈、
 * 焦点与 Escape 由持有端决定。这里是一个最小的浏览器内实现，不依赖 Woohaa Dialog Host。
 */
import { useSyncExternalStore } from "react";
import type {
  EditorDialogInstance,
  EditorDialogPort,
  EditorDialogRegistration,
  EditorDialogRendererProps
} from "@woohaa3/photocraft-editor";

type Entry = { instance: EditorDialogInstance; registration: EditorDialogRegistration; busy: boolean };

export class DevDialogPort implements EditorDialogPort {
  private readonly registrations = new Map<string, EditorDialogRegistration>();
  private stack: Entry[] = [];
  private version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isModalActive = (): boolean => this.stack.length > 0;

  registerDialog(id: string, registration: EditorDialogRegistration): () => void {
    const previous = this.registrations.get(id);
    this.registrations.set(id, registration);
    return () => {
      if (previous) this.registrations.set(id, previous);
      else this.registrations.delete(id);
    };
  }

  open(request: { dialogId: string; payload?: unknown }): { ok: true; instance: EditorDialogInstance } | { ok: false; error: string } {
    const registration = this.registrations.get(request.dialogId);
    if (!registration) return { ok: false, error: "弹窗未注册" };
    const validated = registration.definition.validatePayload(request.payload);
    if (!validated.ok) return { ok: false, error: validated.error };
    const instance: EditorDialogInstance = {
      instanceId: `${request.dialogId}.${this.version + 1}`,
      dialogId: request.dialogId,
      payload: validated.payload
    };
    this.stack.push({ instance, registration, busy: false });
    this.emit();
    return { ok: true, instance };
  }

  top = (): EditorDialogInstance | null => this.stack.at(-1)?.instance ?? null;

  close(instanceId?: string): void {
    const index = instanceId
      ? this.stack.findIndex((entry) => entry.instance.instanceId === instanceId)
      : this.stack.length - 1;
    if (index < 0) return;
    this.stack.splice(index, 1);
    this.emit();
  }

  /** 供渲染端使用的稳定快照（未变化时返回同一引用）。 */
  snapshot(): { instance: EditorDialogInstance; registration: EditorDialogRegistration; busy: boolean } | null {
    return this.stack.at(-1) ?? null;
  }

  setBusy(instanceId: string, busy: boolean): void {
    const entry = this.stack.find((candidate) => candidate.instance.instanceId === instanceId);
    if (!entry || entry.busy === busy) return;
    entry.busy = busy;
    this.emit();
  }

  replace(payload: unknown, instanceId?: string): void {
    const entry = instanceId
      ? this.stack.find((candidate) => candidate.instance.instanceId === instanceId)
      : this.stack.at(-1);
    if (!entry) return;
    entry.instance = { ...entry.instance, payload };
    this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** 浏览器内最小弹窗宿主：只呈现栈顶 renderer。 */
export function DevDialogHost({ port }: { port: DevDialogPort }) {
  const entry = useSyncExternalStore(port.subscribe, () => port.snapshot());
  if (!entry) return null;
  const props: EditorDialogRendererProps = {
    instance: entry.instance,
    requestClose: () => port.close(entry.instance.instanceId),
    setBusy: (busy) => port.setBusy(entry.instance.instanceId, busy),
    replace: (payload) => port.replace(payload, entry.instance.instanceId)
  };
  return (
    <div className="dev-dialog-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !entry.busy) props.requestClose();
    }}>
      <div className="dev-dialog-frame">{entry.registration.renderer(props)}</div>
    </div>
  );
}
