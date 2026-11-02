import { expect, test as base, type Browser, type BrowserType, type LaunchOptions } from "@playwright/test";
import { reviewEndpoint, reviewMode } from "./review-target.js";

/**
 * 复核用浏览器通道。
 *
 * 配置了 WOOHAA_REVIEW_CDP_URL（或别名 ATC_REVIEW_CDP_URL）就连接该远端 CDP 浏览器；
 * 未配置时才启动本机无头浏览器。连接失败直接抛错，不静默降级 —— 否则会拿本机结果
 * 冒充真机结论。远端连接必须用 connectOverCDP：Playwright Test 的 use.connectOptions
 * 走的是私有握手协议，连不了裸 CDP。
 */
export const test = base.extend({
	browser: async ({ browserName, launchOptions, playwright }, use) => {
		const browser = await openReviewBrowser(playwright[browserName] as BrowserType, launchOptions);
		try {
			await use(browser);
		} finally {
			await browser.close();
		}
	},
});

/**
 * 视觉基线的快照后缀。
 *
 * Playwright 默认把 `process.platform`（跑测试的这台机器）写进基线文件名，跨机复核就会
 * 让“Linux 命名的基线”实际由 Windows 上的浏览器渲染。这里改成按**浏览器所在系统**命名，
 * 并加 `cdp-` 前缀：CDP 复核生成的基线不会覆盖本机基线，哪个系统渲染的一眼可辨。
 */
test.beforeEach(async ({ browser }, testInfo) => {
	if (reviewMode !== "cdp") return;
	testInfo.snapshotSuffix = `cdp-${await reviewBrowserPlatform(browser)}`;
});

/** 取得本次复核使用的浏览器：CDP 优先，未配置才本机启动。 */
export async function openReviewBrowser(
	browserType: BrowserType,
	launchOptions: LaunchOptions = {}
): Promise<Browser> {
	if (reviewMode === "cdp") {
		return browserType.connectOverCDP(reviewEndpoint, { timeout: 30_000 });
	}
	return browserType.launch({ headless: true, ...launchOptions });
}

let platformPromise: Promise<string> | undefined;

/** 从浏览器 UA 推断宿主系统，用于视觉基线命名。 */
export function reviewBrowserPlatform(browser: Browser): Promise<string> {
	platformPromise ??= (async () => {
		try {
			const session = await browser.newBrowserCDPSession();
			const { userAgent } = (await session.send("Browser.getVersion")) as { userAgent?: string };
			await session.detach();
			const ua = userAgent ?? "";
			if (/Windows/i.test(ua)) return "win32";
			if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
			if (/Linux|X11/i.test(ua)) return "linux";
		} catch {
			// 取不到就退到 unknown：宁可名字怪异，也不冒充某个平台。
		}
		return "unknown";
	})();
	return platformPromise;
}

export { expect };
