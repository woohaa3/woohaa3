/**
 * 查看页确定性时钟 / locale / timezone
 * （change: add-showcase-history-model-panels，任务 2.3）。
 *
 * 生产历史页用 `date.toLocaleString(undefined, …)` 渲染本地时间；不同机器/时区会让
 * 截图与列表文案漂移。查看页里把 `Date.prototype.toLocale*` 的默认 locale 与 timeZone
 * 固定成 fixture 值——**只影响查看页**，不改动生产代码，也不新增持久化。
 *
 * 注意：`Date.prototype.toLocaleString` 走的是内建格式化器，覆盖 `Intl.DateTimeFormat`
 * 全局不会影响它；所以这里直接补默认参数到原型方法上。
 */

export const SHOWCASE_TIME_ZONE = "Asia/Shanghai";
export const SHOWCASE_LOCALE = "zh-CN";

const METHODS = ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const;
type LocaleMethod = (typeof METHODS)[number];

export function installFixedClock(options: { locale?: string; timeZone?: string } = {}): () => void {
	const locale = options.locale ?? SHOWCASE_LOCALE;
	const timeZone = options.timeZone ?? SHOWCASE_TIME_ZONE;

	const originals = new Map<LocaleMethod, Date[LocaleMethod]>();
	const restore: Array<() => void> = [];

	for (const method of METHODS) {
		const original = Date.prototype[method] as (this: Date, locales?: unknown, format?: unknown) => string;
		originals.set(method, original as Date[LocaleMethod]);
		const patched = function (this: Date, locales?: unknown, format?: Intl.DateTimeFormatOptions) {
			const merged: Intl.DateTimeFormatOptions = { timeZone, ...(format ?? {}) };
			return original.call(this, locales ?? locale, merged);
		};
		Date.prototype[method] = patched as Date[LocaleMethod];
		restore.push(() => {
			Date.prototype[method] = originals.get(method)!;
		});
	}

	return () => {
		for (const undo of restore) undo();
	};
}
