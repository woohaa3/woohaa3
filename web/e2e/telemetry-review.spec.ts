/**
 * 本机遥测复盘页 `/telemetry` 的端到端验收
 * （change: 2026-10-20-add-local-client-telemetry，验证项 10.1–10.3）。
 *
 * 走真实三服务拓扑（`e2e/server.mjs`）：事件经真实 intake 落进真实 SQLite，再由真实
 * `/api/telemetry/*` 读出来渲染。断言四件事：
 * - 空态与有记录态是**两种不同事实**，不合并成"暂无数据"；
 * - 注入 25 条（10 条失败）后，异常规则 `failure-rate-spike` 真的在界面上命中并给出证据；
 * - 聚合表、事件列表与 footer 的口径一致，且 `status.eventCount` / `bytes` / `storePath` 对得上；
 * - 筛选状态进 URL：`?window=1h&name=canvas.edit` 直接打开就生效，且页面不装配任何画布资源。
 */
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type SeededEvent = {
	name: string;
	result: string;
	origin: string;
	surface?: string;
	durationMs?: number;
	errorCode?: string;
	occurredAt?: number;
};

/**
 * 25 条事件。
 *
 * 关键点：`failure-rate-spike` 的样本门槛是**按事件名**算的（design D6 的 `count(W) ≥ 20`），
 * 所以失败必须集中在同一个事件名上凑够 20 条样本——把 7 条失败摊到 `sync.reconcile` 上只有
 * 7 条样本，规则会（正确地）不命中。
 */
function seedEvents(now: number): SeededEvent[] {
	const events: SeededEvent[] = [];
	// 20 条 canvas.edit：12 成功 + 8 失败 = 40% 失败率，越过了 20% 阈值且样本数恰好够。
	for (let index = 0; index < 20; index += 1) {
		const failed = index >= 12;
		events.push({
			name: "canvas.edit",
			result: failed ? "failure" : "success",
			origin: "browser",
			surface: "editor",
			durationMs: 10 + index,
			...(failed ? { errorCode: "canvas.edit.rejected" } : {})
		});
	}
	// 5 条 sync.reconcile 失败：用于验证详情面板展示错误码与属性（样本不足，不会单独触发失败率规则）。
	for (let index = 0; index < 5; index += 1) {
		events.push({
			name: "sync.reconcile",
			result: "failure",
			origin: "browser",
			surface: "sync",
			durationMs: 900 + index,
			errorCode: "sync.upstream.timeout",
			attributes: { phase: "reconcile" }
		});
	}
	// `occurredAt` 只做展示；窗口与保留只认宿主接收时间，所以这里不强制设置。
	return events.map((event) => ({ ...event, occurredAt: now }));
}

async function openTelemetryPage(page: Page): Promise<void> {
	await page.goto("/telemetry");
	await expect(page.getByTestId("telemetry-page")).toBeVisible();
}

test.describe.serial("本机遥测复盘页", () => {
	test("空态：还没有本机记录（与「记录已关闭」是不同事实）", async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		await openTelemetryPage(page);

		await expect(page.getByTestId("telemetry-state-empty")).toBeVisible();
		await expect(page.getByTestId("telemetry-state-empty")).toContainText("还没有本机记录");
		// 空态不是"关闭"也不是"不可用"。
		await expect(page.getByTestId("telemetry-state-disabled")).toHaveCount(0);
		await expect(page.getByTestId("telemetry-state-store-unavailable")).toHaveCount(0);
		expect(pageErrors).toEqual([]);
	});

	test("注入 25 条后：异常命中、聚合与列表口径一致、字节数与库文件对得上", async ({ page, request }) => {
		const now = Date.now();
		const seeded = seedEvents(now);
		const ingested = await request.post("/api/telemetry/events", { data: { events: seeded } });
		expect(ingested.status()).toBe(202);
		const ingestBody = (await ingested.json()) as { accepted: number; dropped: number };
		expect(ingestBody.accepted).toBe(25);
		expect(ingestBody.dropped).toBe(0);

		// 服务端口径：窗口聚合总数就是刚写入的 25 条。
		//
		// `202 accepted` 只表示**已入队**：落盘由 flusher 异步批写（design D7 的"业务路径永不等待
		// I/O"）。所以这里必须等事件真正落库，而不是立刻查聚合——否则测的是 flusher 的运气。
		await expect
			.poll(
				async () => {
					const current = (await (await request.get("/api/telemetry/status")).json()) as { eventCount: number };
					return current.eventCount;
				},
				{ timeout: 15_000, message: "等待 25 条事件落盘" }
			)
			.toBe(25);

		const summary = (await (await request.get("/api/telemetry/summary?window=24h&bucket=1h")).json()) as {
			total: number;
			rows: Array<{ name: string; count: number; results: Record<string, number> }>;
		};
		expect(summary.total).toBe(25);
		const byName = new Map(summary.rows.map((row) => [row.name, row]));
		expect(byName.get("canvas.edit")?.count).toBe(20);
		expect(byName.get("canvas.edit")?.results.failure).toBe(8);
		expect(byName.get("sync.reconcile")?.count).toBe(5);
		expect(byName.get("sync.reconcile")?.results.failure).toBe(5);

		// 状态面：事件数、占用与库文件真实存在，且路径就在临时数据目录里。
		const status = (await (await request.get("/api/telemetry/status")).json()) as {
			enabled: boolean;
			store: string;
			eventCount: number;
			bytes: number;
			storePath?: string;
			droppedOverflow: number;
			droppedInvalid: number;
		};
		expect(status.enabled).toBe(true);
		expect(status.store).toBe("ok");
		expect(status.eventCount).toBe(25);
		expect(status.droppedOverflow).toBe(0);
		expect(status.droppedInvalid).toBe(0);
		expect(status.bytes).toBeGreaterThan(0);
		expect(status.storePath).toBeTruthy();
		// WAL 模式下数据可能暂存在 -wal 文件里，所以这里只断言"库文件真的存在且非空"。
		const stat = fs.statSync(String(status.storePath));
		expect(stat.size).toBeGreaterThan(0);
		const walPath = `${String(status.storePath)}-wal`;
		const onDisk = stat.size + (fs.existsSync(walPath) ? fs.statSync(walPath).size : 0);
		expect(onDisk).toBeGreaterThan(0);

		await openTelemetryPage(page);

		// 异常：失败率突增必须命中，并给出观测值/基线值/样本数。
		const anomaly = page.getByTestId("telemetry-anomaly").filter({ hasText: "失败率突增" });
		await expect(anomaly).toHaveCount(1);
		await expect(anomaly).toContainText("画布编辑");
		await expect(page.getByTestId("telemetry-anomalies-empty")).toHaveCount(0);

		// 聚合表：两个事件名各一行（canvas.edit / sync.reconcile）。
		await expect(page.getByTestId("telemetry-summary-row")).toHaveCount(2);
		// 事件列表首屏是一个有界页（默认 50 条，25 条全部可见）。
		await expect(page.getByTestId("telemetry-event-row")).toHaveCount(25);
		await expect(page.getByTestId("telemetry-footer")).toContainText("25");
		// 没有丢弃时不应出现丢弃提示。
		await expect(page.getByTestId("telemetry-notice-dropped")).toHaveCount(0);

		// 回归：footer 必须排在事件表**之后**，不能被表格溢出的内容盖住。
		// （真实缺陷：页面根是固定高度的滚动容器，`.telemetry__content` 默认 `flex-shrink: 1` 被压缩，
		//   内部表格容器溢出画到 footer 上，两段文字互相重叠。）
		const tableBox = await page.getByTestId("telemetry-events").boundingBox();
		const footerBox = await page.getByTestId("telemetry-footer").boundingBox();
		expect(tableBox).not.toBeNull();
		expect(footerBox).not.toBeNull();
		expect(footerBox!.y).toBeGreaterThanOrEqual(tableBox!.y + tableBox!.height - 1);
	});

	test("事件详情展示属性与错误码", async ({ page }) => {
		// 用 URL 筛选把列表收窄到 5 条：列表区是内部滚动容器，长列表里点第 N 行会因为
		// "element is outside of the viewport" 反复重试。顺带也验证了筛选与详情能一起工作。
		await page.goto("/telemetry?window=1h&name=sync.reconcile");
		await expect(page.getByTestId("telemetry-page")).toBeVisible();

		const row = page.getByTestId("telemetry-event-row").filter({ hasText: "sync.upstream.timeout" }).first();
		await expect(row).toBeVisible();
		// 行本身不是点击目标：详情入口是行内显式的「查看详情」按钮（不做整行点击，避免误触）。
		const openDetail = row.getByRole("button", { name: "查看详情" });
		await openDetail.scrollIntoViewIfNeeded();
		await openDetail.click();
		await expect(page.getByTestId("telemetry-detail")).toBeVisible();
		await expect(page.getByTestId("telemetry-detail")).toContainText("sync.upstream.timeout");
		await expect(page.getByTestId("telemetry-detail")).toContainText("reconcile");
	});

	test("筛选进 URL：?window=1h&name=canvas.edit 直接打开即生效", async ({ page }) => {
		await page.goto("/telemetry?window=1h&name=canvas.edit");
		await expect(page.getByTestId("telemetry-page")).toBeVisible();

		// 只剩 canvas.edit：sync.reconcile 的 5 条被筛掉，且列表里不再出现同步事件。
		//
		// 注意口径：`name` 只筛**事件列表**；窗口聚合（上方的「窗口聚合」表与异常概览）始终是
		// 整个窗口的全景——筛选控件就长在「事件列表」区块里，两者的作用域不同是有意的。
		const rows = page.getByTestId("telemetry-event-row");
		await expect(rows.first()).toBeVisible();
		await expect(rows).toHaveCount(20);
		const listText = (await rows.allInnerTexts()).join("\n");
		expect(listText).toContain("canvas.edit");
		expect(listText).not.toContain("sync.reconcile");

		// 筛选状态就在 URL 里：回到不带查询的地址即"清空筛选"，列表恢复全部 25 条。
		await page.goto("/telemetry");
		await expect(page.getByTestId("telemetry-event-row")).toHaveCount(25);
	});

	test("复盘页不装配画布资源，且刷新后仍停在该页", async ({ page }) => {
		await openTelemetryPage(page);

		// 独立页面：没有 Bevy 运行时、没有画布会话出口。
		expect(
			await page.evaluate(() => typeof (window as never as { __bevyRuntime?: unknown }).__bevyRuntime)
		).toBe("undefined");
		expect(
			await page.evaluate(() => typeof (window as never as { __canvasSubmitCommands?: unknown }).__canvasSubmitCommands)
		).toBe("undefined");

		await page.reload();
		await expect(page.getByTestId("telemetry-page")).toBeVisible();
		expect(new URL(page.url()).pathname).toBe("/telemetry");
	});

	test("返回画布：不经浏览器后退也能离开复盘页", async ({ page }) => {
		// 复盘页是整页路由、应用外壳没有全局顶栏——不能进去就出不来。
		//
		// 第一段：直接打开（URL 里没有 canvasId）→ 返回落到默认画布，真的能看到画布表面。
		await page.goto("/telemetry");
		await expect(page.getByTestId("telemetry-page")).toBeVisible();
		const back = page.getByTestId("telemetry-back");
		await expect(back).toBeVisible();
		await back.click();

		await expect(page.getByTestId("telemetry-page")).toHaveCount(0);
		await expect(page.getByTestId("bevy-canvas-surface")).toBeVisible();
		// 注意：这里**不**断言 URL 里没有 canvasId——返回默认画布后，应用会把解析到的画布 id
		// 规范化写回地址，那是画布页的正常行为，不是"返回失败"。

		// 第二段：带来源画布（模拟"从设置进入"）→ 返回把 canvasId 原样带回去。
		// 这里只断言**路由传参**：该 id 在测试环境不存在，画布页会正确显示"找不到这个画布"，
		// 那是画布页的正常状态，不是返回失败。
		await page.goto("/telemetry?canvasId=e2e-canvas-return");
		await expect(page.getByTestId("telemetry-page")).toBeVisible();
		await page.getByTestId("telemetry-back").click();
		await expect(page.getByTestId("telemetry-page")).toHaveCount(0);
		expect(new URL(page.url()).searchParams.get("canvasId")).toBe("e2e-canvas-return");
	});
});
