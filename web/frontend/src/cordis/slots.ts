/**
 * Typed Slot registry（change: adopt-frontend-cordis-plugin-runtime，design D6）。
 *
 * 自建小型 registry：稳定 slot name、contribution ID、priority、条件 availability 和
 * disposer。同一 slot 内重复 ID 直接抛错（不静默覆盖）；同 priority 按注册序号，再按 ID
 * 形成确定顺序。
 */
import type { SlotContribution, SlotContributionMap, SlotName, SlotsService } from "./contracts.js";
import type { DialogsService } from "./contract/platform.js";

/**
 * 贡献的来源身份（change: 2026-10-21-harden-extension-fault-isolation，design D1）。
 *
 * 由宿主在扩展装配时经注入的 slots 代理盖章，扩展无法设置或改写；宿主内置插件的贡献为 builtin。
 * 读取只走宿主私有的 `slotContributionOrigin()`，不进入 `SlotsService` 写接口。
 * `owner` 仍是贡献方自填的诊断字符串，MUST NOT 作为故障归属依据。
 */
export type SlotContributionOrigin =
  | { kind: "builtin" }
  | { kind: "extension"; extensionId: string; epoch: number };

type AnyContribution = SlotContribution<SlotName>;

/**
 * 宿主私有的来源盖章表（change: 2026-10-21-harden-extension-fault-isolation，design D1）。
 *
 * 键是**宿主创建**的贡献副本，扩展拿不到这个表，也拿不到副本以外的引用，因此无法伪造或改写归属。
 * 不在 extension-api 中导出。
 */
const ORIGINS = new WeakMap<object, SlotContributionOrigin>();
const BUILTIN: SlotContributionOrigin = Object.freeze({ kind: "builtin" });

let assemblyEpoch = 0;

/** 为一次扩展装配分配单调 epoch（页面会话内唯一，重新装配即推进）。 */
export function nextExtensionAssemblyEpoch(): number {
  assemblyEpoch += 1;
  return assemblyEpoch;
}

/** 读取贡献的来源身份；未经扩展代理注册的贡献视为 builtin。 */
export function slotContributionOrigin(contribution: object): SlotContributionOrigin {
  return ORIGINS.get(contribution) ?? BUILTIN;
}

/**
 * 为一个扩展装配创建 dialogs 代理：经它注册的 Dialog renderer 被盖上来源身份，DialogHost 据此为
 * 扩展弹窗单独设置渲染错误边界（change: 2026-10-21-harden-extension-fault-isolation）。
 * 其余方法原样转发到当前 dialogs 服务。
 */
export function createScopedDialogs(base: () => DialogsService | undefined, origin: SlotContributionOrigin): DialogsService {
  const stamped: SlotContributionOrigin = Object.freeze({ ...origin });
  return new Proxy({} as DialogsService, {
    get(_target, prop) {
      const service = base();
      if (prop === "registerDialog") {
        return (dialogId: string, registration: Parameters<DialogsService["registerDialog"]>[1]) => {
          if (registration.renderer && !ORIGINS.has(registration.renderer)) ORIGINS.set(registration.renderer, stamped);
          return service!.registerDialog(dialogId, registration);
        };
      }
      const value = service ? (service as unknown as Record<PropertyKey, unknown>)[prop] : undefined;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(service) : value;
    }
  });
}

/** 扩展装配时注入的宿主盖章服务（slots + dialogs）；供 kernel / reconciler / 设置装配共用。 */
export function scopedExtensionServices(ctx: { get(name: string): unknown }, extensionId: string): { slots: SlotsService; dialogs: DialogsService; epoch: number } {
  const epoch = nextExtensionAssemblyEpoch();
  const origin: SlotContributionOrigin = { kind: "extension", extensionId, epoch };
  return {
    slots: createScopedSlots(() => ctx.get("slots") as SlotsService, origin),
    dialogs: createScopedDialogs(() => ctx.get("dialogs") as DialogsService | undefined, origin),
    epoch
  };
}

/**
 * 为一个扩展装配创建 slots 代理：经它注册的贡献会被复制并盖上 `origin`。
 *
 * - 复制是浅拷贝（`{ ...contribution }`），贡献按既有契约是普通对象；
 * - `base` 以函数延迟解析，避免装配时 slots 尚未提供；
 * - 读取（list/subscribe/version）原样透传。
 */
export function createScopedSlots(base: () => SlotsService, origin: SlotContributionOrigin): SlotsService {
  const stamped: SlotContributionOrigin = Object.freeze({ ...origin });
  return {
    register(slot, contribution) {
      const copy = { ...contribution } as typeof contribution;
      ORIGINS.set(copy as object, stamped);
      return base().register(slot, copy);
    },
    list: (slot) => base().list(slot),
    subscribe: (slot, listener) => base().subscribe(slot, listener),
    version: () => base().version()
  };
}

export class SlotRegistry implements SlotsService {
  private readonly slots = new Map<SlotName, AnyContribution[]>();
  private readonly listeners = new Map<SlotName, Set<() => void>>();
  private readonly serials = new WeakMap<AnyContribution, number>();
  private serial = 0;
  private revision = 0;

  register<S extends SlotName>(slot: S, contribution: SlotContribution<S>): () => void {
    if (!contribution.id) throw new Error(`slot ${slot} 的 contribution 缺少 id`);
    const list = this.slots.get(slot) ?? [];
    const duplicate = list.find((entry) => entry.id === contribution.id);
    if (duplicate) {
      throw new Error(
        `slot "${slot}" 已存在 contribution "${contribution.id}"（owner ${duplicate.owner} → ${contribution.owner}）`
      );
    }
    const entry = contribution as AnyContribution;
    this.serials.set(entry, ++this.serial);
    list.push(entry);
    list.sort((a, b) => compareContributions(a, b, this.serials));
    this.slots.set(slot, list);
    this.emit(slot);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.slots.get(slot);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
      this.emit(slot);
    };
  }

  list<S extends SlotName>(slot: S): ReadonlyArray<SlotContribution<S>> {
    const all = this.slots.get(slot) ?? [];
    // node-action / selection-action 的 available 接收目标上下文，由消费方（横条）在正确上下文下
    // 调用；这里只对无参谓词（其它 slot 的既有契约）求值。
    const filtered = all.filter((entry) => {
      const predicate = entry.available as ((context?: unknown) => boolean) | undefined;
      if (!predicate) return true;
      if (predicate.length > 0) return true;
      return predicate();
    });
    return filtered as unknown as ReadonlyArray<SlotContribution<S>>;
  }

  subscribe(slot: SlotName, listener: () => void): () => void {
    const set = this.listeners.get(slot) ?? new Set();
    set.add(listener);
    this.listeners.set(slot, set);
    return () => {
      set.delete(listener);
    };
  }

  version(): number {
    return this.revision;
  }

  /** 诊断：已注册的所有 slot、owner 与宿主盖章的来源身份。 */
  owners(): Array<{ slot: SlotName; id: string; owner: string; priority: number; origin: SlotContributionOrigin }> {
    const out: Array<{ slot: SlotName; id: string; owner: string; priority: number; origin: SlotContributionOrigin }> = [];
    for (const [slot, list] of this.slots) {
      for (const entry of list) {
        out.push({ slot, id: entry.id, owner: entry.owner, priority: entry.priority ?? 0, origin: slotContributionOrigin(entry) });
      }
    }
    return out;
  }

  private emit(slot: SlotName): void {
    this.revision += 1;
    for (const listener of this.listeners.get(slot) ?? []) listener();
  }
}

function compareContributions(a: AnyContribution, b: AnyContribution, serials: WeakMap<AnyContribution, number>): number {
  const priority = (a.priority ?? 0) - (b.priority ?? 0);
  if (priority !== 0) return priority;
  const serial = (serials.get(a) ?? 0) - (serials.get(b) ?? 0);
  if (serial !== 0) return serial;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 供宿主在无 Context 环境下读取 contribution props 的类型保护（编译期断言辅助）。 */
export type SlotRegistration<S extends SlotName> = SlotContributionMap[S];
