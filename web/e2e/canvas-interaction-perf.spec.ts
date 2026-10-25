/**
 * 画布交互热路径**测试专用**性能采集
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 6.1–6.3）。
 *
 * 与生产/正常 preview 分离：只在本测试 harness 里采集，不启用开发采集写接口。使用浏览器
 * 标准 `PerformanceObserver`：
 * - `event` timing（`processingStart`/`processingEnd`/`duration`）：生产等价的输入处理与
 *   到呈现的端到端耗时（跨优化前后一致口径）；
 * - `longtask`：>50ms 长任务区间，用于分析释放长尾。
 *
 * 同时读取确定性计数器 `window.__canvasSceneDiagnostics.snapshot()`：纯 pan/zoom 是否真正
 * 跳过完整场景构建、世界索引与静态 mesh 重建；空闲帧是否零工作。
 *
 * 固定场景（PERF_NODES）、DPR（PERF_DPR）与构建产物（E2E_DIST）；`PERF_LABEL` 标注 pre/post。
 * 原始样本按 JSONL 写入 `PERF_OUT`（缺省 `artifacts/performance-canvas-hot-path/<label>`）。
 */
import { expect, test } from "@playwright/test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installPageHelpers, waitForCanvasSession, seedYjsCanvas } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LABEL = process.env.PERF_LABEL ?? "post";
const DPR = Number(process.env.PERF_DPR ?? 1);
const NODES = Number(process.env.PERF_NODES ?? 300);
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 5);
const OUT_DIR = process.env.PERF_OUT ?? resolve(repoRoot, "artifacts", "performance-canvas-hot-path", LABEL);

/** 确定性计数器（pre 构建缺 viewport/Rust 字段时为 undefined）。 */
type Counters = Record<string, number>;

function seedCanvas(count: number) {
	const nodes: Array<Record<string, unknown>> = [];
	const nodeData: Record<string, unknown> = {};
	for (let i = 0; i < count; i += 1) {
		const id = `perf-${i}`;
		const x = 300 + (i % 20) * 120;
		const y = 200 + Math.floor(i / 20) * 130;
		nodes.push({ id, type: i % 5 === 0 ? "model3d" : "text", position: { x, y }, width: 260, height: 195, zIndex: i + 1 });
		nodeData[id] = { title: `节点 ${i}`, prompt: `第 ${i} 个` };
	}
	return {
		id: CANVAS,
		title: "画布交互热路径基准",
		revision: 1,
		document: { schemaVersion: "asset-canvas-v1", nodes, edges: [], updatedAt: "2026-10-10T00:00:00.000Z" },
		nodeData,
		assets: [],
		jobs: [],
		updatedAt: "2026-10-10T00:00:00.000Z"
	};
}

type Harness = {
	events: Array<{ name: string; startTime: number; processingStart: number; processingEnd: number; duration: number; interactionId: number }>;
	longtasks: Array<{ startTime: number; duration: number }>;
	requestAnimationFrame(cb: FrameRequestCallback): number;
	__perfFlush(): { events: Harness["events"]; longtasks: Harness["longtasks"] };
};

async function installTiming(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		const w = window as unknown as Harness & { __perfInstalled?: boolean };
		w.events = [];
		w.longtasks = [];
		w.__perfInstalled = true;
		try {
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					w.events.push({
						name: e.name,
						startTime: e.startTime,
						processingStart: (e as PerformanceEventTiming).processingStart ?? e.startTime,
						processingEnd: (e as PerformanceEventTiming).processingEnd ?? e.startTime + e.duration,
						duration: e.duration,
						interactionId: (e as PerformanceEventTiming).interactionId ?? 0
					});
				}
			}).observe({ type: "event", durationThreshold: 0 } as PerformanceObserverInit);
		} catch {
			/* 环境不支持：events 保持为空。 */
		}
		try {
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) w.longtasks.push({ startTime: e.startTime, duration: e.duration });
			}).observe({ entryTypes: ["longtask"] });
		} catch {
			/* 环境不支持。 */
		}
		w.__perfFlush = () => {
			const events = w.events.slice();
			const longtasks = w.longtasks.slice();
			w.events = [];
			w.longtasks = [];
			return { events, longtasks };
		};
		// 生产等价同步处理器计时：包装 canvas 的 pointer/wheel 监听，记录 `performance.now()`
		// 包围的同步处理耗时。Event Timing 不默认观察 pointermove/mousemove，故滚动/移动
		// 处理器用此口径；与 dev 采集的 handlerMs 定义一致。
		const handlerLog = (window as unknown as { __perfHandlerLog?: Array<{ name: string; duration: number }> }).__perfHandlerLog = [];
		const seen = new WeakSet<object>();
		const originalAdd = EventTarget.prototype.addEventListener;
		EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
			if (listener && (type === "pointerdown" || type === "pointermove" || type === "pointerup" || type === "pointercancel" || type === "wheel")) {
				const target = this as Element;
				if (target && (target as Element).id === "bevy-canvas" && !seen.has(listener as object)) {
					seen.add(listener as object);
					const wrapped = (event: Event) => {
						const start = performance.now();
						try {
							if (typeof listener === "function") (listener as EventListener)(event);
							else listener.handleEvent(event);
						} finally {
							handlerLog.push({ name: type, duration: performance.now() - start });
						}
					};
					return originalAdd.call(this, type, wrapped, options);
				}
			}
			return originalAdd.call(this, type, listener as EventListener, options);
		};
		(w as unknown as { __perfHandlerFlush?: () => Array<{ name: string; duration: number }> }).__perfHandlerFlush = () => {
			const log = handlerLog.slice();
			handlerLog.length = 0;
			return log;
		};
	});
}

async function flushTiming(page: import("@playwright/test").Page) {
	return page.evaluate(() => (window as unknown as Harness).__perfFlush());
}

type HandlerLog = Array<{ name: string; duration: number }>;

/** 读取并清空 canvas 同步处理器计时（与 dev 采集 handlerMs 同口径）。 */
async function flushHandlers(page: import("@playwright/test").Page): Promise<HandlerLog> {
	return page.evaluate(() => (window as unknown as { __perfHandlerFlush?: () => HandlerLog }).__perfHandlerFlush?.() ?? []);
}

function summarizeHandlers(log: HandlerLog, names: string[]) {
	const durations = log.filter((entry) => names.includes(entry.name)).map((entry) => entry.duration);
	return { ...percentiles(durations), over50: durations.filter((v) => v > 50).length };
}

async function counters(page: import("@playwright/test").Page): Promise<Counters> {
	return page.evaluate(
		() => ((window as unknown as { __canvasSceneDiagnostics?: { snapshot(): Counters } }).__canvasSceneDiagnostics?.snapshot?.() ?? {}) as Counters
	);
}

/**
 * 等待计数器稳定：软件渲染环境下 Bevy 帧周期可达数百毫秒，hover 之类的失效可能在下一个
 * 帧才结算并污染本阶段增量。连续两次读数一致（间隔 `step`）才认为该帧已结算（静置）。
 */
async function settleCounters(page: import("@playwright/test").Page, step = 1200, tries = 8): Promise<Counters> {
	let previous = await counters(page);
	for (let i = 0; i < tries; i += 1) {
		await page.waitForTimeout(step);
		const next = await counters(page);
		if (sameCounters(previous, next)) return next;
		previous = next;
	}
	return previous;
}

function sameCounters(a: Counters, b: Counters): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
	return true;
}

function percentiles(values: number[]): { count: number; p50: number; p95: number; max: number; mean: number } {
	if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, mean: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
	return {
		count: values.length,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted[sorted.length - 1]!,
		mean: values.reduce((a, b) => a + b, 0) / values.length
	};
}

/** 记录一个 phase 的原始样本（事件处理耗时 + duration + longtask），并返回汇总。 */
function summarizeEvents(events: Harness["events"], names: string[]) {
	const relevant = events.filter((e) => names.includes(e.name));
	const handler = relevant.map((e) => e.processingEnd - e.processingStart);
	const duration = relevant.map((e) => e.duration);
	return {
		handler: percentiles(handler),
		duration: percentiles(duration),
		over50: [...handler, ...duration].filter((v) => v > 50).length,
		samples: relevant
	};
}

test.describe("画布交互热路径基准", () => {
	test.beforeAll(() => {
		mkdirSync(OUT_DIR, { recursive: true });
	});

	test("pan / zoom / drag 确定性与延迟对照", async ({ page }) => {
		await installPageHelpers(page);
		await installTiming(page);
		await seedYjsCanvas(page, CANVAS, [], { canvas: seedCanvas(NODES) as never });
		await page.goto("/");
		await waitForCanvasSession(page);
		// 等渲染器与派生追上。
		await page.waitForFunction(
			(expected: number) => ((window as unknown as { __canvasCanonical?: { revision?: number } }).__canvasCanonical?.revision ?? -1) >= expected,
			1,
			{ timeout: 60_000, polling: 100 }
		);
		await page.waitForTimeout(1500);

		const canvas = page.locator("#bevy-canvas");
		const box = await canvas.boundingBox();
		expect(box, "canvas 外框").not.toBeNull();
		const cx = box!.x + box!.width / 2;
		const cy = box!.y + box!.height / 2;

		// 开发采集已删除，页面不再注入 `__woohaaBuildIdentity`；只用实际 dist 的 WASM 字节做构建对照。
		const distWasm = buildWasmIdentity(process.env.E2E_DIST ?? "frontend/dist");

		// ---------- 空闲静止：60 帧内零构建/零提交 ----------
		const idleBefore = await settleCounters(page);
		await page.waitForTimeout(1000);
		const idleAfter = await counters(page);

		const rawLines: string[] = [];
		const record = (phase: string, data: Record<string, unknown>) =>
			rawLines.push(JSON.stringify({ label: LABEL, dpr: DPR, nodes: NODES, phase, ...data }));

		const roundSummary: Array<Record<string, unknown>> = [];

		// 每个 round：空闲稳定后分别做 pan / zoom / drag，各自读取计数器增量与事件样本。
		for (let round = 0; round < ROUNDS; round += 1) {
			// ---- pan：中键拖动 20 步 ----
			await page.mouse.move(cx, cy);
			await flushTiming(page);
			await settleCounters(page);
			// 按下会清除 hover 投影（可能触发一帧 full）；先结算这一帧，再测量纯平移增量。
			await page.mouse.down({ button: "middle" });
			const panBefore = await settleCounters(page);
			await flushTiming(page);
			await flushHandlers(page);
			for (let i = 1; i <= 20; i += 1) {
				await page.mouse.move(cx + i * 6, cy + i * 3);
				await page.waitForTimeout(16);
			}
			await page.mouse.up({ button: "middle" });
			const panAfter = await settleCounters(page);
			const panTiming = await flushTiming(page);
			const panHandlers = await flushHandlers(page);
			const panHM = summarizeHandlers(panHandlers, ["pointerdown", "pointermove", "pointerup"]);
			const pan = summarizeEvents(panTiming.events, ["pointerdown", "pointermove", "pointerup"]);
			const panCounters = delta(panBefore, panAfter);
			record("pan", { counters: panCounters, handler: panHM, duration: pan.duration, over50: panHM.over50, longtasks: panTiming.longtasks });

			// ---- zoom：ctrl+wheel 20 次 ----
			await page.mouse.move(cx, cy);
			await flushTiming(page);
			const zoomBefore = await settleCounters(page);
			await flushTiming(page);
			await flushHandlers(page);
			for (let i = 0; i < 20; i += 1) {
				await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
				await page.waitForTimeout(16);
			}
			const zoomAfter = await settleCounters(page);
			const zoomTiming = await flushTiming(page);
			const zoomHandlers = await flushHandlers(page);
			const zoomHM = summarizeHandlers(zoomHandlers, ["wheel"]);
			const zoom = summarizeEvents(zoomTiming.events, ["wheel"]);
			const zoomCounters = delta(zoomBefore, zoomAfter);
			record("zoom", { counters: zoomCounters, handler: zoomHM, duration: zoom.duration, over50: zoomHM.over50, longtasks: zoomTiming.longtasks });

			// ---- drag：选中一个文本节点拖动 20 步后释放 ----
			// 计算该节点的绝对世界坐标对应的 client 坐标（节点 index 2 为 text，避开模型节点）。
			const targetWorld = await page.evaluate(() => {
				const nodes = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string; position: { x: number; y: number }; width?: number; height?: number }> } } }).__canvasCanonical?.document?.nodes ?? [];
				const node = nodes.find((n) => n.id === "perf-2") ?? nodes[1] ?? nodes[0];
				return node ? { x: node.position.x + 60, y: node.position.y + 50 } : null;
			});
			const targetClient = await page.evaluate((world: { x: number; y: number } | null) => {
				if (!world) return null;
				const vp = (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
				const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
				return { x: world.x * vp.zoom + vp.x + rect.left, y: world.y * vp.zoom + vp.y + rect.top };
			}, targetWorld);
			if (!targetClient) throw new Error("找不到拖动目标节点");
			await page.mouse.move(targetClient.x, targetClient.y);
			await flushTiming(page);
			await settleCounters(page);
			// 按下清除 hover 投影可能触发一帧 full；先结算再测量拖动与释放增量。
			await page.mouse.down();
			const dragBefore = await settleCounters(page);
			await flushTiming(page);
			await flushHandlers(page);
			for (let i = 1; i <= 20; i += 1) {
				await page.mouse.move(targetClient.x + i * 5, targetClient.y + i * 3);
				await page.waitForTimeout(16);
			}
			await page.mouse.up();
			const dragAfter = await settleCounters(page);
			const dragTiming = await flushTiming(page);
			const dragHandlers = await flushHandlers(page);
			const downUpHM = summarizeHandlers(dragHandlers, ["pointerdown", "pointerup"]);
			const moveHM = summarizeHandlers(dragHandlers, ["pointermove"]);
			const downUp = summarizeEvents(dragTiming.events, ["pointerdown", "pointerup"]);
			const move = summarizeEvents(dragTiming.events, ["pointermove"]);
			const dragCounters = delta(dragBefore, dragAfter);
			record("drag", { counters: dragCounters, downUp: downUpHM, move: moveHM, over50: downUpHM.over50 + moveHM.over50, longtasks: dragTiming.longtasks });

			roundSummary.push({ round, panCounters, zoomCounters, dragCounters, panHandlerP95: panHM.p95, zoomHandlerP95: zoomHM.p95, downP95: downUpHM.p95, moveP95: moveHM.p95 });

			// 复位视口与选择，减少轮次间漂移。
			await page.evaluate(() => (window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.([]));
			await settleCounters(page);
		}

		// 写入原始 JSONL 与会话摘要。
		writeFileSync(resolve(OUT_DIR, `raw-${LABEL}-dpr${DPR}-n${NODES}.jsonl`), rawLines.join("\n") + "\n", { flag: "w" });
		appendFileSync(
			resolve(OUT_DIR, "sessions.jsonl"),
			JSON.stringify({ label: LABEL, dpr: DPR, nodes: NODES, rounds: ROUNDS, wasm: distWasm, idle: delta(idleBefore, idleAfter), roundSummary: roundSummary }) + "\n"
		);

		// eslint-disable-next-line no-console
		console.log(`[perf-canvas] ${LABEL} dpr=${DPR} nodes=${NODES}\n` + JSON.stringify({ wasm: distWasm, idle: delta(idleBefore, idleAfter), roundSummary }, null, 2));

		// ---- 确定性门槛 ----
		// 空闲帧零工作（common 字段在 pre/post 均存在）。
		expect(idleAfter.sceneBuilds, "空闲不构建").toBe(idleBefore.sceneBuilds);
		expect(idleAfter.sceneSubmits, "空闲不提交").toBe(idleBefore.sceneSubmits);

		// ---- post 构建专有确定性门槛（pre 构建无这些字段，跳过） ----
		const hasViewportFields = idleBefore.viewportSubmits !== undefined;
		if (hasViewportFields) {
			for (const r of roundSummary) {
				const pan = r.panCounters as Counters;
				const zoom = r.zoomCounters as Counters;
				expect(pan.viewportSubmits, "pan 走视口增量").toBeGreaterThan(0);
				expect(zoom.viewportSubmits, "zoom 走视口增量").toBeGreaterThan(0);
				expect(pan.sceneSubmits, "pan 不提交完整场景").toBe(0);
				expect(zoom.sceneSubmits, "zoom 不提交完整场景").toBe(0);
				expect(pan.sceneBuilds, "pan 零完整构建").toBe(0);
				expect(pan.worldSnapshotBuilds, "pan 零世界索引重建").toBe(0);
				expect(pan.pickCandidateBuilds, "pan 零模型候选重建").toBe(0);
				expect(pan.meshBuilds, "pan 零静态 mesh 重建").toBe(0);
				expect(pan.modelRegistrations, "pan 零模型注册").toBe(0);
				expect(zoom.sceneBuilds, "zoom 零完整构建").toBe(0);
				expect(zoom.worldSnapshotBuilds, "zoom 零世界索引重建").toBe(0);
				expect(zoom.meshBuilds, "zoom 零静态 mesh 重建").toBe(0);
				expect(zoom.modelRegistrations, "zoom 零模型注册").toBe(0);
			}
			// 纯视口单帧边界 payload 独立于全场规模（viewports 提交字节远小于整场 JSON）。
			const panBytes = (roundSummary[0].panCounters as Counters).boundaryBytes ?? 0;
			expect(panBytes, "pan 边界字节为固定视口大小量级").toBeLessThan(5000);
		}
	});
});

function delta(before: Counters, after: Counters): Counters {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	const out: Counters = {};
	for (const key of keys) out[key] = (after[key] ?? 0) - (before[key] ?? 0);
	return out;
}

/** 从构建产物目录读取 wasm 身份（sha256）与文件大小，用于固定 JS/WASM 构建身份。 */
function buildWasmIdentity(distDir: string): { file: string; sha256: string; bytes: number } | null {
	try {
		const assetsDir = resolve(repoRoot, "web", distDir, "assets");
		const match = readdirSync(assetsDir).find((name) => name.startsWith("woohaa_bevy_canvas_bg") && name.endsWith(".wasm"));
		if (!match) return null;
		const bytes = readFileSync(join(assetsDir, match));
		return { file: match, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
	} catch {
		return null;
	}
}
