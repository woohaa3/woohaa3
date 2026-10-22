import { FOUNDATION_SLOTS, requiredFoundationSlots, type AssembledFoundationProviders, type BootstrapExtension, type FoundationProviders, type FoundationSlot, type StorageProvider } from "@woohaa3/contracts";

/** 先校验完整依赖图，再产生资源；不存在隐式 provider 或按导入顺序覆盖。 */
export async function bootstrapProviders<S extends StorageProvider>(extensions: readonly BootstrapExtension<S>[]) {
  const declarations = new Map<FoundationSlot, { owner: string; definition: BootstrapExtension<S>["providers"][number] }>();
  const owners = new Set<string>();
  for (const extension of extensions) {
    if (owners.has(extension.extensionId)) throw new Error(`重复 bootstrap extension：${extension.extensionId}`);
    owners.add(extension.extensionId);
    for (const definition of extension.providers) {
      if (!(FOUNDATION_SLOTS as readonly string[]).includes(definition.slot)) throw new Error(`未知 provider：${definition.slot}`);
      const previous = declarations.get(definition.slot);
      if (previous) throw new Error(`重复 provider ${definition.slot}：${previous.owner}、${extension.extensionId}`);
      declarations.set(definition.slot, { owner: extension.extensionId, definition });
    }
  }
  const required = requiredFoundationSlots([...declarations.keys()]);
  for (const slot of required) {
    if (!declarations.has(slot)) throw new Error(`缺少必需 provider：${slot}`);
  }
  const order: FoundationSlot[] = [];
  const visiting = new Set<FoundationSlot>();
  const visit = (slot: FoundationSlot) => {
    if (order.includes(slot)) return;
    if (visiting.has(slot)) throw new Error(`provider 依赖循环：${[...visiting, slot].join(" → ")}`);
    const registration = declarations.get(slot);
    if (!registration) throw new Error(`缺少 provider 依赖：${slot}`);
    visiting.add(slot);
    for (const dependency of registration.definition.requires) visit(dependency);
    visiting.delete(slot);
    order.push(slot);
  };
  for (const slot of declarations.keys()) visit(slot);

  const values: Partial<FoundationProviders<S>> = {};
  const disposers: Array<() => void | Promise<void>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "基础 provider 释放失败");
  };
  try {
    for (const slot of order) {
      const { definition } = declarations.get(slot)!;
      const result = await definition.create({ get(dependency) {
        if (!definition.requires.includes(dependency)) throw new Error(`${slot} 未声明依赖 ${dependency}`);
        if (!values[dependency]) throw new Error(`${dependency} 尚未初始化`);
        return values[dependency]!;
      } });
      // mapped union 的写入只发生在声明的 slot；结果与 slot 的类型由公开契约绑定。
      Object.assign(values, { [slot]: result.value });
      if (result.dispose) disposers.push(result.dispose);
      if (!result.value || typeof result.value.providerId !== "string") throw new Error(`${slot} 返回无效 provider`);
      const ready = "ready" in result.value ? result.value.ready : undefined;
      if (typeof ready === "function" && !ready.call(result.value)) throw new Error(`${slot} provider 未就绪`);
    }
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "基础 provider 启动失败"); }
    throw error;
  }
  return {
    providers: values as AssembledFoundationProviders<S>,
    accessControl: declarations.has("identity"),
    owners: Object.fromEntries([...declarations].map(([slot, entry]) => [slot, entry.owner])) as Partial<Record<FoundationSlot, string>> & { storage: string },
    close
  };
}
