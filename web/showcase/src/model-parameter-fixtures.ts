/**
 * 模型参数面板查看页夹具
 * （change: add-showcase-history-model-panels，任务 3.3–3.4；
 *  change: remove-model-placement-panel —— 面板移除模型摆放控件，只保留复制反馈）。
 *
 * 生产 `ModelParameterPanel` 通过 `copyText` 注入复制实现。这里提供确定性的 clipboard
 * adapter（永不触碰运行主机的真实 clipboard）。
 */

export type CopyAdapter = {
	/** 交给 `copyText` 的调用记录。 */
	calls: string[];
	copyText: (value: string) => Promise<boolean>;
	setResult: (ok: boolean) => void;
};

/** 注入式 clipboard adapter：默认成功，可切换为失败；不访问真实系统 clipboard。 */
export function createCopyAdapter(initial: boolean = true): CopyAdapter {
	let ok = initial;
	const calls: string[] = [];
	return {
		calls,
		async copyText(value: string) {
			calls.push(value);
			return ok;
		},
		setResult(next: boolean) {
			ok = next;
		}
	};
}
