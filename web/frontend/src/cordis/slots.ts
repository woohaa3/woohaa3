/**
 * Typed Slot registry（change: adopt-frontend-cordis-plugin-runtime，design D6）。
 *
 * 自建小型 registry：稳定 slot name、contribution ID、priority、条件 availability 和
 * disposer。同一 slot 内重复 ID 直接抛错（不静默覆盖）；同 priority 按注册序号，再按 ID
 * 形成确定顺序。
 */
import type { SlotContribution, SlotContributionMap, SlotName, SlotsService } from "./contracts.js";

type AnyContribution = SlotContribution<SlotName>;

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

  /** 诊断：已注册的所有 slot 与 owner。 */
  owners(): Array<{ slot: SlotName; id: string; owner: string; priority: number }> {
    const out: Array<{ slot: SlotName; id: string; owner: string; priority: number }> = [];
    for (const [slot, list] of this.slots) {
      for (const entry of list) out.push({ slot, id: entry.id, owner: entry.owner, priority: entry.priority ?? 0 });
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
