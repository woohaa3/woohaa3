/** A disposed Provider may retain a receipt handle, but cannot send a new authenticated request. */
export function createProviderLifecycleFetch(host: { effect(callback: () => () => void): unknown }, upstream: typeof fetch = globalThis.fetch): typeof fetch {
  let active = true;
  host.effect(() => () => { active = false; });
  return (async (input, init) => {
    if (!active) throw Object.assign(new Error("模型提供商已停用或认证配置已变化"), { sourceStale: true });
    return upstream(input, init);
  }) as typeof fetch;
}
