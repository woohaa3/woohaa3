// jsdom 不实现 matchMedia / scrollIntoView / ResizeObserver；生产组件（mention 编辑器、
// 弹窗焦点管理）在挂载时会用到，补最小实现避免测试因环境缺失而失败。
if (typeof window !== "undefined") {
	if (!window.matchMedia) {
		// @ts-expect-error 测试环境补齐
		window.matchMedia = (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		});
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => undefined;
	}
	if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
		class NoopResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
	}
}
