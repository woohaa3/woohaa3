/**
 * 复盘页的四种"非正常"状态（change: 2026-10-20-add-local-client-telemetry，验证项 10.3/10.4）。
 *
 * 这些状态在健康的本地单实例上无法自然出现（记录默认开着、库可写、没有注册任何出口），
 * 所以用**路由拦截**构造 `/api/telemetry/status` 的返回，验证页面把四种事实分开呈现：
 * 记录已关闭 / 存储不可用 / 服务不可用 / 有丢弃（以及外部上报已开启的顶部提示）。
 *
 * 状态**来源**的行为不靠这里断言：`enabled=false` 与"库打不开"分别由
 * `web/backend/src/host/core/telemetry.test.ts` 与 `telemetry-service` 的单测覆盖
 * （含"既有库文件字节级不变"）。这里是界面分支的验收。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import type { TelemetryStatus } from "@woohaa3/contracts";

function status(overrides: Partial<TelemetryStatus> = {}): TelemetryStatus {
	return {
		enabled: true,
		exportEnabled: false,
		store: "ok",
		storePath: "/tmp/woohaa3/telemetry.sqlite",
		queued: 0,
		droppedInvalid: 0,
		droppedOverflow: 0,
		writeErrors: 0,
		eventCount: 0,
		bytes: 0,
		exports: [],
		...overrides
	} as TelemetryStatus;
}

/**
 * 拦截遥测四个读面：`status` 用给定值，其余返回空集合。
 *
 * 必须全部拦截——页面并行请求这四个端点，只拦一个会让真数据混进来，断言就不再是"这个状态"。
 */
async function stubTelemetry(page: Page, options: { status: TelemetryStatus | number }): Promise<void> {
	await page.route("**/api/telemetry/**", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path.endsWith("/status")) {
			if (typeof options.status === "number") {
				await route.fulfill({ status: options.status, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) });
				return;
			}
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.status) });
			return;
		}
		if (path.endsWith("/events")) {
			const empty = { events: [], ...(options.status !== undefined ? {} : {}) };
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(empty) });
			return;
		}
		if (path.endsWith("/summary")) {
			const now = Date.now();
			const empty = { window: "24h", bucket: "1h", since: now - 86_400_000, until: now, total: 0, rows: [], series: [] };
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(empty) });
			return;
		}
		if (path.endsWith("/anomalies")) {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ anomalies: [] }) });
			return;
		}
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
	});
}

test.describe("复盘页的状态区分", () => {
	test("本地记录已关闭：说清后果并给开启入口，而不是显示「没有记录」", async ({ page }) => {
		await stubTelemetry(page, { status: status({ enabled: false }) });
		await page.goto("/telemetry");

		const disabled = page.getByTestId("telemetry-state-disabled");
		await expect(disabled).toBeVisible();
		await expect(disabled).toContainText("本机遥测记录已关闭");
		// 不能说成"没有记录"：那是另一种事实（开着但确实没事件）。
		await expect(page.getByTestId("telemetry-state-empty")).toHaveCount(0);
		// 必须给出口（去设置里打开）。
		await expect(page.getByTestId("telemetry-state-disabled").getByRole("button")).toHaveCount(1);
	});

	test("存储不可用：给出文件路径，且不冒充其它状态", async ({ page }) => {
		await stubTelemetry(page, {
			status: status({ store: "unavailable", storePath: "/tmp/woohaa3/broken-telemetry.sqlite" })
		});
		await page.goto("/telemetry");

		const unavailable = page.getByTestId("telemetry-state-store-unavailable");
		await expect(unavailable).toBeVisible();
		await expect(unavailable).toContainText("本地存储不可用");
		await expect(unavailable).toContainText("/tmp/woohaa3/broken-telemetry.sqlite");
		await expect(page.getByTestId("telemetry-state-disabled")).toHaveCount(0);
	});

	test("服务不可用：403 时显示可读文案与重试，不白屏", async ({ page }) => {
		await stubTelemetry(page, { status: 403 });
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		await page.goto("/telemetry");
		const unavailable = page.getByTestId("telemetry-state-unavailable");
		await expect(unavailable).toBeVisible();
		await expect(unavailable).toContainText("遥测服务不可用");
		await expect(page.getByTestId("telemetry-retry")).toBeVisible();
		expect(pageErrors).toEqual([]);
	});

	test("有丢弃时明确提示缺口（复盘时要知道数据不全）", async ({ page }) => {
		await stubTelemetry(page, {
			status: status({ eventCount: 12, droppedOverflow: 3, droppedInvalid: 2, store: "ok" })
		});
		await page.goto("/telemetry");

		const notice = page.getByTestId("telemetry-notice-dropped");
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("3");
		await expect(notice).toContainText("2");
	});

	test("开着上报但不接入任何报告出口：指向「服务端接入」扩展而不是含糊报错", async ({ page }) => {
		// 这是用户真会踩的坑：开关在核心设置里，出口却由「服务端接入」扩展注册（默认关闭）。
		await stubTelemetry(page, { status: status({ exportEnabled: true, exports: [] }) });
		await page.goto("/telemetry");

		const notice = page.getByTestId("telemetry-notice-export-unrouted");
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute("data-reason", "no-export");
		await expect(notice).toContainText("没有任何上报出口");
		await expect(notice).toContainText("服务端接入");
		// 不能同时显示"正在上报"的提示。
		await expect(page.getByTestId("telemetry-notice-export")).toHaveCount(0);
	});

	test("出口在但不可用（未连接/未登录）：提示连接，而不是当成没有出口", async ({ page }) => {
		await stubTelemetry(page, {
			status: status({
				exportEnabled: true,
				exports: [{ exportId: "remote", label: "服务端接入", available: false, dropped: 0 }]
			})
		});
		await page.goto("/telemetry");

		const notice = page.getByTestId("telemetry-notice-export-unrouted");
		await expect(notice).toHaveAttribute("data-reason", "no-provider-available");
		await expect(notice).toContainText("未连接服务端");
	});

	test("外部上报已开启时顶部明确提示目的地（不静默外发）", async ({ page }) => {
		await stubTelemetry(page, {
			status: status({
				exportEnabled: true,
				exports: [{ exportId: "remote", label: "服务端接入", available: true, dropped: 0 }]
			})
		});
		await page.goto("/telemetry");

		const notice = page.getByTestId("telemetry-notice-export");
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("服务端接入");
	});
});
