/**
 * 扩展贡献同步回调的故障归因
 * （change: 2026-10-21-harden-extension-fault-isolation，design D2/D3）。
 *
 * 宿主在非渲染路径同步调用扩展回调（菜单项生成、节点模板、拖放接收、横条动作、粘贴/拖入处理）
 * 时，经这里把异常归因到宿主盖章的扩展身份并计入 `extensionFaults` 熔断；宿主内置贡献保持原语义。
 * 纯逻辑模块（不含 React/CSS），非 tsx 插件也可使用。
 */
import { slotContributionOrigin } from "./slots.js";
import type { ExtensionFaultService } from "./extension-faults.js";
import type { ContextMenuContext, SlotContribution } from "./contract/platform.js";

type ContextMenuContribution = SlotContribution<"canvas.context-menu">;

/** 合并 context-menu 贡献的菜单项；扩展贡献的 `items()` 抛错时只丢掉它自己的菜单项（design D2）。 */
export function guardedContextMenuItems(contributions: ReadonlyArray<ContextMenuContribution>, faults: ExtensionFaultService | undefined, context: ContextMenuContext) {
  return contributions.flatMap((entry) => guardContributionCall(entry, "canvas.context-menu", faults, () => entry.items(context), []));
}

/** 分发 context-menu 选择到各贡献；扩展贡献的 `onSelect` 抛错时归因并继续分发。 */
export function selectGuardedContextMenuItem(contributions: ReadonlyArray<ContextMenuContribution>, faults: ExtensionFaultService | undefined) {
  return (itemId: string, context: ContextMenuContext) => {
    for (const entry of contributions) guardContributionCall(entry, "canvas.context-menu", faults, () => entry.onSelect(itemId, context), undefined);
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 扩展贡献抛错时上报（kind=callback）；返回是否为扩展贡献。 */
export function reportContributionFault(
  entry: object & { id?: string },
  slot: string,
  faults: ExtensionFaultService | undefined,
  error: unknown
): boolean {
  const origin = slotContributionOrigin(entry);
  if (origin.kind !== "extension") return false;
  console.error("[extension-contribution]", error);
  faults?.report({
    extensionId: origin.extensionId,
    epoch: origin.epoch,
    slot,
    contributionId: entry.id ?? "unknown",
    message: messageOf(error),
    kind: "callback"
  });
  return true;
}

/**
 * 调用扩展贡献的同步回调并隔离异常：扩展贡献抛错（或返回的 Promise 拒绝）时上报故障并返回
 * `fallback`，即跳过该贡献、回落宿主默认行为；宿主内置贡献照常抛出。
 */
export function guardContributionCall<T>(
  entry: object & { id?: string },
  slot: string,
  faults: ExtensionFaultService | undefined,
  call: () => T,
  fallback: T
): T {
  if (slotContributionOrigin(entry).kind !== "extension") return call();
  try {
    const result = call();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as unknown as Promise<unknown>).then(undefined, (error: unknown) => {
        reportContributionFault(entry, slot, faults, error);
        return undefined;
      }) as unknown as T;
    }
    return result;
  } catch (error) {
    reportContributionFault(entry, slot, faults, error);
    return fallback;
  }
}

/**
 * 包装扩展贡献的若干方法：抛错时先归因上报，再**原样抛出**，让宿主既有的 try/catch 默认行为
 * （跳过该动作、拒绝拖入、按不可用处理）继续生效。内置贡献与非扩展来源原样返回。
 */
const guardedCopies = new WeakMap<object, Map<string, object>>();

export function guardContributionMethods<T extends object>(
  entry: T,
  slot: string,
  faults: ExtensionFaultService | undefined,
  methods: readonly (keyof T & string)[]
): T {
  if (slotContributionOrigin(entry).kind !== "extension") return entry;
  // 按贡献对象缓存（横条描述等每帧调用的路径不重复分配）；faults 是 App 单例，不进缓存键。
  const cacheKey = `${slot}|${methods.join(",")}`;
  let perEntry = guardedCopies.get(entry);
  const cached = perEntry?.get(cacheKey);
  if (cached) return cached as T;
  const copy = { ...entry } as Record<string, unknown>;
  for (const name of methods) {
    const original = copy[name];
    if (typeof original !== "function") continue;
    const wrapped = (...args: unknown[]) => {
      try {
        return (original as (...input: unknown[]) => unknown).apply(entry, args);
      } catch (error) {
        reportContributionFault(entry as object & { id?: string }, slot, faults, error);
        throw error;
      }
    };
    // 保留形参个数：SlotRegistry 等处按 `length` 区分带上下文的谓词。
    Object.defineProperty(wrapped, "length", { value: (original as (...input: unknown[]) => unknown).length });
    copy[name] = wrapped;
  }
  if (!perEntry) {
    perEntry = new Map();
    guardedCopies.set(entry, perEntry);
  }
  perEntry.set(cacheKey, copy);
  return copy as T;
}
