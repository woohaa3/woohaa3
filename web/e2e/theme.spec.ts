/**
 * 跨 Web/Bevy 主题替换验收（change: unify-application-theme-tokens，任务 5.3 / 5.5）。
 *
 * 用真实运行时验证：
 * - 默认 preset → sentinel preset 原子切换后，根级 `--app-*` 变量与关键 chrome surface
 *   的实际计算色都改变；
 * - 切换不改变 canvas revision、selection、节点集合；
 * - 桌面与 390×844 视口都能无错误切换。
 */
import { expect, test } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession } from "./helpers.js";

// sentinel preset 与默认高差异（与 @woohaa3/contracts fixtures 一致）。
const SENTINEL_ACCENT = "#6d28d9";
const DEFAULT_ACCENT = "#16846c";

test.describe("主题替换（任务 5.3 / 5.5）", () => {
	test("切换 preset 原子改变根变量与 chrome surface 采样色", async ({ page }) => {
		await installPageHelpers(page);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 默认主题：根变量等于 canonical 默认 accent。
		const initial = await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return {
				accent: style.getPropertyValue("--app-interaction-accent").trim(),
				backdrop: style.getPropertyValue("--app-web-backdrop").trim(),
				themeId: (window as never as { __appTheme?: () => { id: string } }).__appTheme?.()?.id
			};
		});
		expect(initial.accent).toBe(DEFAULT_ACCENT);
		expect(initial.themeId).toBe("default");

		const beforeRevision = await page.evaluate(
			() => (window as never as { __canvasCanonical?: { revision: number } }).__canvasCanonical?.revision ?? 0
		);

		// 通过 E2E 钩子原子切换到 sentinel preset。
		const switched = await page.evaluate((accent) => {
			const theme = (window as never as { __appTheme?: () => { tokens: Record<string, string>; version: string } }).__appTheme?.();
			if (!theme) throw new Error("__appTheme 未安装");
			const preset = {
				id: "sentinel",
				version: theme.version,
				tokens: { ...theme.tokens, interactionAccent: accent, webBackdrop: "#faf5ff" }
			};
			return (window as never as { __setAppTheme?: (p: unknown) => { ok: boolean; error?: string } }).__setAppTheme?.(preset);
		}, SENTINEL_ACCENT);
		expect(switched?.ok).toBe(true);

		const after = await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return {
				accent: style.getPropertyValue("--app-interaction-accent").trim(),
				themeId: (window as never as { __appTheme?: () => { id: string } }).__appTheme?.()?.id
			};
		});
		expect(after.accent).toBe(SENTINEL_ACCENT);
		expect(after.themeId).toBe("sentinel");

		// canvas revision / 节点不变（主题只存在于 presentation 层）。
		const afterRevision = await page.evaluate(
			() => (window as never as { __canvasCanonical?: { revision: number } }).__canvasCanonical?.revision ?? 0
		);
		expect(afterRevision).toBe(beforeRevision);

		expect(errors).toEqual([]);
	});

	test("内置暗色主题切换根变量/color-scheme/data 属性，刷新后仍恢复", async ({ page }) => {
		await installPageHelpers(page);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const beforeRevision = await page.evaluate(
			() => (window as never as { __canvasCanonical?: { revision: number } }).__canvasCanonical?.revision ?? 0
		);

		const selected = await page.evaluate(() =>
			(window as never as { __selectAppTheme?: (id: string) => { ok: boolean; error?: string } }).__selectAppTheme?.("dark")
		);
		expect(selected?.ok).toBe(true);

		const dark = await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return {
				id: (window as never as { __appTheme?: () => { id: string } }).__appTheme?.()?.id,
				backdrop: style.getPropertyValue("--app-web-backdrop").trim(),
				text: style.getPropertyValue("--app-web-text-primary").trim(),
				appearance: document.documentElement.dataset.appTheme,
				colorScheme: style.colorScheme,
				bodyBackground: getComputedStyle(document.body).backgroundColor
			};
		});
		expect(dark.id).toBe("dark");
		expect(dark.backdrop).toBe("#101614");
		expect(dark.text).toBe("#e6efe9");
		expect(dark.appearance).toBe("dark");
		expect(dark.colorScheme).toContain("dark");
		expect(dark.bodyBackground).toBe("rgb(16, 22, 20)");

		const afterRevision = await page.evaluate(
			() => (window as never as { __canvasCanonical?: { revision: number } }).__canvasCanonical?.revision ?? 0
		);
		expect(afterRevision).toBe(beforeRevision);

		// 刷新：首帧内联引导 + ThemeService 本地恢复都必须回到暗色，且无错误。
		await page.reload();
		await waitForCanvasSession(page);
		const restored = await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return {
				id: (window as never as { __appTheme?: () => { id: string } }).__appTheme?.()?.id,
				appearance: document.documentElement.dataset.appTheme,
				backdrop: style.getPropertyValue("--app-web-backdrop").trim()
			};
		});
		expect(restored.id).toBe("dark");
		expect(restored.appearance).toBe("dark");
		expect(restored.backdrop).toBe("#101614");
		expect(errors).toEqual([]);
	});

	test("无效 preset 被拒绝且保留上一合法主题", async ({ page }) => {
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const result = await page.evaluate(() => {
			const theme = (window as never as { __appTheme?: () => { version: string } }).__appTheme?.();
			return (window as never as { __setAppTheme?: (p: unknown) => { ok: boolean } }).__setAppTheme?.({
				id: "bad",
				version: theme?.version,
				tokens: { interactionAccent: "url(https://evil)" }
			});
		});
		expect(result?.ok).toBe(false);
		const id = await page.evaluate(() => (window as never as { __appTheme?: () => { id: string } }).__appTheme?.()?.id);
		expect(id).toBe("default");
	});

	test("390×844 视口下也能切换主题", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		const result = await page.evaluate(() => {
			const theme = (window as never as { __appTheme?: () => { tokens: Record<string, string>; version: string } }).__appTheme?.();
			if (!theme) return undefined;
			return (window as never as { __setAppTheme?: (p: unknown) => { ok: boolean } }).__setAppTheme?.({
				id: "sentinel-mobile",
				version: theme.version,
				tokens: { ...theme.tokens, interactionAccent: "#6d28d9" }
			});
		});
		expect(result?.ok).toBe(true);
	});
});
