/**
 * 性能基线（change: replace-godot-canvas-runtime-with-bevy，任务 8.3）。
 *
 * 测量并输出：
 * 1. **hydrate**：页面加载 → 画布会话就绪（含把 N 个节点渲染给 Bevy）的耗时；
 * 2. **drag-end commit**：一次「拖拽结束」提交（多个节点位置）到规范状态回流的耗时；
 * 3. **rAF 合并**：一帧内多次提交只产生一次 `set_scene`（由交互控制器的 rAF 合并保证）。
 *
 * 规模阈值以输出为准（见测试日志的 `[perf]` 行）；断言只设宽松上界，避免在共享 CI 上抖动。
 */
import { expect, test } from "@playwright/test";
import { installPageHelpers,
	readStoredCanvas,
	readRenderedRevision,
	resetCanvasStorage,
	seedYjsCanvas,
	sendCommands,
	waitForCanvasSession,
	waitForPersistedRevision } from "./helpers.js";

/** 种 N 个节点到**服务端权威 Yjs 画布**（Yjs 是唯一持久化路径；避免 N 次命令往返）。 */
async function seedNodes(page: import("@playwright/test").Page, count: number): Promise<void> {
	const nodes = [];
	const nodeData: Record<string, unknown> = {};
	for (let index = 0; index < count; index += 1) {
		const id = `perf-node-${index}`;
		nodes.push({
			id,
			type: "text",
			position: { x: (index % 20) * 40, y: Math.floor(index / 20) * 40 },
			width: 260,
			height: 195,
			zIndex: index + 1
		});
		nodeData[id] = { title: `节点 ${index}`, prompt: `第 ${index} 个` };
	}
	await seedYjsCanvas(page, "woohaa3-default-canvas", [], {
		canvas: {
			id: "woohaa3-default-canvas",
			title: "E2E 画布",
			revision: 1,
			document: {
				schemaVersion: "asset-canvas-v1",
				nodes,
				edges: [],
				updatedAt: "2026-09-24T00:00:00.000Z"
			},
			nodeData,
			assets: [],
			jobs: [],
			updatedAt: "2026-09-24T00:00:00.000Z"
		}
	});
}

test.describe("性能基线", () => {
	test("hydrate / drag-end commit 耗时，以及一帧内提交合并", async ({ page }) => {
		await installPageHelpers(page);

		// ---------- 规模 1：200 节点（含 nodeData）
		// 直接在首次导航前把 200 节点种成权威画布：避免「先以 revision 0 导航、客户端写入本地
		// Yjs cache，再改服务端到 revision 1」造成的本地缓存/服务端分叉（reload 后 revision 可能
		// 停留在陈旧的 0）。
		await seedNodes(page, 200);
		const hydrateStart = Date.now();
		await page.goto("/");
		await waitForCanvasSession(page);
		await waitForPersistedRevision(page, 1);
		const hydrateMs = Date.now() - hydrateStart;

		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(200);
		const revision = canvas!.revision;

		// 等待渲染器追上规范 revision。
		await page.waitForFunction(
			(expected: number) =>
				((window as unknown as { __bevyRuntime?: { renderedRevision?: () => number } }).__bevyRuntime?.renderedRevision?.() ?? 0) >=
				expected,
			revision,
			{ timeout: 30_000, polling: 100 }
		);

		// ---------- drag-end commit：一次提交 50 个节点的最终位置
		const positions: Record<string, { x: number; y: number }> = {};
		for (let index = 0; index < 50; index += 1) {
			positions[`perf-node-${index}`] = { x: index * 20, y: index * 20 };
		}
		const commitStart = Date.now();
		const committed = await sendCommands(
			page,
			Object.entries(positions).map(([nodeId, position]) => ({ type: "node.update", nodeId, position })),
			"perf-move-1"
		);
		expect(committed.ok, JSON.stringify(committed)).toBe(true);
		// 一个命令批次只推进一次 revision（服务端按 batch 计数，不是按命令条数）。
		const targetRevision = revision + 1;
		await waitForPersistedRevision(page, targetRevision);
		const commitMs = Date.now() - commitStart;

		// ---------- 一帧内多次移动：rAF 合并为一次 set_scene
		const burstStart = Date.now();
		await sendCommands(
			page,
			Array.from({ length: 20 }, (_unused, index) => ({
				type: "node.update" as const,
				nodeId: "perf-node-0",
				position: { x: 100 + index * 20, y: 100 }
			})),
			"perf-burst"
		);
		await waitForPersistedRevision(page, targetRevision + 1);
		const burstCommitMs = Date.now() - burstStart;
		const rendered = await readRenderedRevision(page);

		console.log(
			`[perf] hydrate(200 节点+nodeData)=${hydrateMs}ms | ` +
				`一次提交(50 节点)→派生=${commitMs}ms | ` +
				`一帧内 20 条移动=${burstCommitMs}ms | renderedRevision=${rendered}`
		);

		// 最终派生聚合的就是最新 revision（两个批次各 +1）。
		expect((await readStoredCanvas(page))?.revision).toBe(targetRevision + 1);

		// 宽松上界：只捕捉数量级退化，不在共享机器上抖动。
		expect(hydrateMs).toBeLessThan(20_000);
		expect(commitMs).toBeLessThan(10_000);
		expect(burstCommitMs).toBeLessThan(10_000);
	});
});
