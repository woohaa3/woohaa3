/**
 * 换版窗口登记（C 方向：进程内热切换）。
 *
 * 同一个扩展的插件名不能并存，所以热切换是「先卸后装」：从撤下旧 fiber 到新版本装配完成
 * 之间，该扩展注册的 Provider / 路由 / 监听都不存在。这段时间的请求如果直接落到 404，
 * 调用方会把它当成「扩展不存在」这种永久失败；实际上它只是短暂不可用。
 *
 * 这里登记「正在换版」的扩展，由网关在 application 之前拦一道，返回可重试的
 * `extension-reloading`（带 `Retry-After`），把「短暂空窗」和「真的没有」区分开。
 *
 * 进程内单例即可：Extension Manager 本身是单例，换版是串行提交的。
 */
const swapping = new Set<string>();

export function beginSwap(extensionId: string): void {
  swapping.add(extensionId);
}

export function endSwap(extensionId: string): void {
  swapping.delete(extensionId);
}

export function isSwapping(extensionId: string): boolean {
  return swapping.has(extensionId);
}

/** 只用于测试复位。 */
export function clearSwaps(): void {
  swapping.clear();
}
