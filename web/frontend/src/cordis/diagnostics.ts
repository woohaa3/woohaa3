/**
 * Runtime diagnostics（change: adopt-frontend-cordis-plugin-runtime，design D10）。
 *
 * 只读快照：Plugin ID、状态、缺失 Service、失败原因与已注册 contribution。**不**输出
 * 凭据、媒体签名 URL 或 prompt 正文。
 */
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { ExtensionDiagnostic, ExtensionStatus, RuntimeDiagnostics, RuntimeStatus } from "./contracts.js";

export type ExtensionManifestEntry = {
  id: string;
  required: boolean;
  /** Cordis fiber（`ctx.plugin()` 返回的 wrapper，原型指向真实 fiber）。 */
  fiber: Fiber;
};

/**
 * 未装配的 optional Plugin 的**合成**诊断（change: add-frontend-plugin-manager，design D2/D3）。
 * 不持有 fiber，只表达“用户禁用”稳定状态，区别于 waiting/failed/disposed。
 */
export type DisabledExtensionEntry = {
  id: string;
  required: false;
  /** 稳定原因（固定文案；不回显用户配置内容）。 */
  reason: string;
};

/**
 * `FiberState` 在依赖里是 ambient `const enum`，`verbatimModuleSyntax` 下不可访问；
 * 这里以数字镜像其稳定取值（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING）。
 */
const FIBER_PENDING = 0;
const FIBER_LOADING = 1;
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;

const STATUS_BY_FIBER_STATE: Record<number, ExtensionStatus> = {
  [FIBER_PENDING]: "pending",
  [FIBER_LOADING]: "loading",
  [FIBER_ACTIVE]: "active",
  [FIBER_FAILED]: "failed",
  [FIBER_DISPOSED]: "disposed",
  [FIBER_UNLOADING]: "unloading"
};

export class DiagnosticsService implements RuntimeDiagnostics {
  private readonly listeners = new Set<() => void>();
  private status: RuntimeStatus = { phase: "starting", error: null, plugins: [] };
  private readonly entries = new Map<string, ExtensionManifestEntry>();
  private readonly disabled = new Map<string, DisabledExtensionEntry>();
  private readonly contributions = new Map<string, Set<string>>();

  constructor(private readonly ctx: Context) {}

  addExtension(entry: ExtensionManifestEntry): () => void {
    // `ctx.plugin()` 返回的是原型指向真实 fiber 的 wrapper；事件派发的是真实 fiber。
    // root fiber 本身就是 Fiber 实例，不能误当作 wrapper 再取一次原型。
    const candidate = Object.getPrototypeOf(entry.fiber) as Fiber | null;
    const realFiber = candidate && Object.hasOwn(candidate, "uid") ? candidate : entry.fiber;
    this.entries.set(entry.id, { ...entry, fiber: realFiber });
    const off = this.ctx.on("internal/status", (fiber: Fiber) => {
      if (fiber === realFiber) this.recompute();
    });
    this.recompute();
    return () => {
      off();
      this.entries.delete(entry.id);
      this.recompute();
    };
  }

  /** 记录未装配的 optional Plugin（用户禁用）：合成 `disabled` 诊断，不持有 fiber。 */
  addDisabled(entry: DisabledExtensionEntry): () => void {
    this.disabled.set(entry.id, entry);
    this.recompute();
    return () => {
      this.disabled.delete(entry.id);
      this.recompute();
    };
  }

  /** 记录某个 Plugin 注册的 contribution（slot/dialog owner）。 */
  trackContribution(extensionId: string, contribution: string): () => void {
    const set = this.contributions.get(extensionId) ?? new Set<string>();
    set.add(contribution);
    this.contributions.set(extensionId, set);
    this.recompute();
    return () => {
      set.delete(contribution);
      this.recompute();
    };
  }

  markReady(): void {
    this.update({ phase: "ready", error: null });
  }

  markFailed(error: string): void {
    this.update({ phase: "failed", error });
  }

  getStatus = (): RuntimeStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private recompute(): void {
    const plugins: ExtensionDiagnostic[] = [];
    for (const entry of this.entries.values()) {
      plugins.push({
        id: entry.id,
        required: entry.required,
        status: fiberStatus(entry.fiber),
        // Cordis 4.1 keeps the resolved service implementations in the
        // public `committed` snapshot; the old `fiber.store` accessor was
        // removed. A pending/failed fiber has no committed snapshot, so all
        // required injections are correctly reported as missing.
        missingServices: Object.keys(entry.fiber.inject).filter((name) => !entry.fiber.committed?.[name]),
        ...(entry.fiber.state === FIBER_FAILED ? { error: "插件启动失败" } : {}),
        contributions: [...(this.contributions.get(entry.id) ?? [])].sort()
      });
    }
    for (const entry of this.disabled.values()) {
      plugins.push({
        id: entry.id,
        required: false,
        status: "disabled",
        missingServices: [],
        contributions: [],
        reason: entry.reason
      });
    }
    plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.update({ plugins });
  }

  private update(patch: Partial<RuntimeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function fiberStatus(fiber: Fiber): ExtensionStatus {
  return STATUS_BY_FIBER_STATE[fiber.state] ?? "pending";
}
