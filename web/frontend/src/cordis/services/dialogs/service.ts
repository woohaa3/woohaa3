/**
 * Dialogs Service（change: adopt-frontend-cordis-plugin-runtime，design D3/D6/D7）。
 *
 * 无 React 的 capability facade：把现有 `DialogHostStore`、`DialogRegistry` 与
 * renderer/alert-action registry 收拢到可注入的 Service，并让注册返回 disposer。
 * 生产模块不再 import-time 永久注册 dialog。
 */
import type { DialogInstance, OpenDialogRequest, OpenDialogResult } from "./types.js";
import type { DialogRenderer } from "./renderer-registry.js";
import type { DialogHostSnapshot } from "./host-store.js";
import type {
  DialogCloseGuard,
  DialogCloseResult,
  DialogRegistration,
  DialogsService
} from "../../contracts.js";
import { DialogHostStore } from "./host-store.js";
import { DialogRegistry } from "./registry.js";

export type AlertAction = () => Promise<{ ok: true } | { ok: false; error: string }>;

export type DialogServiceOptions = {
  store?: DialogHostStore;
  registry?: DialogRegistry;
};

/**
 * 可注入 Dialog 能力。默认单例绑定现有 store 与 registry；测试可注入全新实例。
 */
export class DialogService implements DialogsService {
  private readonly store: DialogHostStore;
  private readonly registry: DialogRegistry;
  private readonly renderers = new Map<string, DialogRenderer>();
  private readonly actions = new Map<string, AlertAction>();

  constructor(options: DialogServiceOptions = {}) {
    this.registry = options.registry ?? options.store?.registryRef() ?? new DialogRegistry();
    this.store = options.store ?? new DialogHostStore(this.registry);
  }

  // --- Host API -----------------------------------------------------------

  getSnapshot = (): DialogHostSnapshot => this.store.getSnapshot();
  subscribe = (listener: (snapshot: DialogHostSnapshot) => void): (() => void) => this.store.subscribe(listener);

  open(request: OpenDialogRequest): OpenDialogResult {
    const validation = this.registry.validate(request.dialogId, request.payload);
    if (!validation.ok) return this.store.open(request);
    return this.store.open(request);
  }

  replace(payload: unknown, instanceId?: string): boolean {
    return this.store.replace(payload, instanceId);
  }

  close(instanceId?: string): boolean {
    return this.store.close(instanceId);
  }

  closeTop(): boolean {
    return this.store.closeTop();
  }

  setBusy(instanceId: string, busy: boolean): boolean {
    return this.store.setBusy(instanceId, busy);
  }

  top(): DialogInstance | null {
    return this.store.top();
  }

  find(instanceId: string): DialogInstance | null {
    return this.store.find(instanceId);
  }

  requestCloseTop(): DialogCloseResult {
    return this.store.requestCloseTop();
  }

  requestClose(instanceId?: string): DialogCloseResult {
    return this.store.requestClose(instanceId);
  }

  registerCloseGuard(dialogId: string, guard: DialogCloseGuard): () => void {
    return this.store.registerCloseGuard(dialogId, guard);
  }

  getDiagnostic(): string | null {
    return this.store.getDiagnostic();
  }

  isModalActive(): boolean {
    return this.store.getSnapshot().isModalActive;
  }

  // --- Registrations (reversible) ----------------------------------------

  registerDialog(dialogId: string, registration: DialogRegistration): () => void {
    if (!dialogId) throw new Error("dialogId 不能为空");
    if (this.registry.has(dialogId)) {
      throw new Error(`dialog "${dialogId}" 已被注册`);
    }
    this.registry.register(dialogId, registration.definition);
    let disposeRenderer: (() => void) | undefined;
    if (registration.renderer) {
      this.renderers.set(dialogId, registration.renderer);
      disposeRenderer = () => this.renderers.delete(dialogId);
    }
    return () => {
      disposeRenderer?.();
      this.registry.unregister(dialogId);
    };
  }

  registerAlertAction(key: string, action: AlertAction): () => void {
    if (!key) throw new Error("actionKey 不能为空");
    if (this.actions.has(key)) throw new Error(`alert action "${key}" 已被注册`);
    this.actions.set(key, action);
    return () => {
      if (this.actions.get(key) === action) this.actions.delete(key);
    };
  }

  resolveRenderer(dialogId: string): DialogRenderer | null {
    return this.renderers.get(dialogId) ?? null;
  }

  resolveAlertAction(key: string | undefined): AlertAction | null {
    if (!key) return null;
    return this.actions.get(key) ?? null;
  }

  registeredDialogIds(): string[] {
    return this.registry.ids();
  }

  /** 注册 Dialog open pre-commit participant（change: unify-canvas-presentation-navigation）。 */
  registerOpenParticipant(participant: import("./types.js").DialogOpenParticipant): () => void {
    return this.store.registerOpenParticipant(participant);
  }
}
