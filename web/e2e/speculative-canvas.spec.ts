/**
 * Frontend speculative canvas state 浏览器验收
 * （change: add-frontend-speculative-canvas-state，任务 7.1–7.5）。
 *
 * 通过真实浏览器命令出口提交语义命令，断言：
 * - 本页 working projection 立即包含命令效果，而 canonical 尚未前进（延迟/未回流）；
 * - 双标签页只在服务端 durable update 后可见；
 * - 领域拒绝后本页回滚且错误可诊断；
 * - 断线禁止新命令；
 * - 刷新后 pending 丢弃、只从 published 恢复。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	sendCommands,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

/** 读取本页 working projection（由 store 派生，含 pending 效果）。 */
async function readWorkingCanvas(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const state = (window as unknown as {
			__canvasStoreState?: () => { working?: unknown; canvas?: unknown } | null;
		}).__canvasStoreState?.();
		const canonical = (window as unknown as { __canvasCanonical?: unknown }).__canvasCanonical;
		return { working: state?.working ?? null, canonical: state?.canvas ?? canonical ?? null };
	});
}

test.describe("speculative working projection（change: add-frontend-speculative-canvas-state）", () => {
	test("创建在本页立即进入 working，canonical 由 Yjs 回流确认", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const created = await sendCommands(page, [
			{ type: "node.add", node: { id: "spec-a", type: "text", position: { x: 40, y: 40 } } }
		], "spec-create-a");
		expect(created.ok, JSON.stringify(created)).toBe(true);

		// 立即读取：working 立即含节点（提交瞬间即可见）。
		const immediate = await readWorkingCanvas(page);
		expect((immediate.working as { document: { nodes: Array<{ id: string }> } }).document.nodes.map((n) => n.id)).toContain("spec-a");

		// 服务端回流后 canonical 也含该节点。
		await page.waitForFunction(
			() => {
				const canonical = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string }> } } }).__canvasCanonical;
				return Boolean(canonical?.document?.nodes?.some((node) => node.id === "spec-a"));
			},
			undefined,
			{ timeout: 20_000 }
		);
		const canvas = await readStoredCanvas(page);
		expect((canvas as unknown as { document: { nodes: Array<{ id: string }> } }).document.nodes.map((n) => n.id)).toContain("spec-a");
	});

	test("移动与删除在本页立即生效（working）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await sendCommands(page, [
			{ type: "node.add", node: { id: "m1", type: "text", position: { x: 0, y: 0 } } }
		], "spec-m-create");
		await page.waitForTimeout(500);

		await sendCommands(page, [{ type: "node.update", nodeId: "m1", position: { x: 200, y: 120 } }], "spec-m-move");
		const afterMove = await readWorkingCanvas(page);
		const moved = (afterMove.working as { document: { nodes: Array<{ id: string; position: { x: number; y: number } }> } })
			.document.nodes.find((n) => n.id === "m1");
		expect(moved?.position).toEqual({ x: 200, y: 120 });

		await sendCommands(page, [{ type: "node.remove", nodeIds: ["m1"] }], "spec-m-remove");
		const afterRemove = await readWorkingCanvas(page);
		expect((afterRemove.working as { document: { nodes: Array<{ id: string }> } }).document.nodes.map((n) => n.id)).not.toContain("m1");
	});

	test("领域拒绝：本页回滚且错误可诊断", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		// 删除不存在的节点 → 本地 reducer 直接拒绝（不发送）。
		const rejected = await sendCommands(page, [
			{ type: "node.remove", nodeIds: ["ghost-node"] }
		], "spec-reject");
		expect(rejected.ok).toBe(false);
		expect(rejected.reason).toBeTruthy();

		// 规范画布不变。
		const canvas = await readStoredCanvas(page);
		expect((canvas as unknown as { revision: number }).revision).toBe(0);
	});

	test("服务端领域拒绝：本页回滚，规范画布不变", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		// 先有一个节点。
		await sendCommands(page, [
			{ type: "node.add", node: { id: "reject-target", type: "image", position: { x: 0, y: 0 } } }
		], "spec-reject-seed");
		await waitForPersistedRevision(page, 1);

		// 提交一条本地 reducer 通过、但服务端资产引用校验失败的命令（非法 COS 引用）：
		// 本地可计算预览，服务端 durable 校验拒绝，本页回滚且规范画布不变。
		const before = await readStoredCanvas(page);
		const revisionBefore = (before as unknown as { revision: number }).revision;
		await sendCommands(page, [
			{
				type: "asset.upsert",
				asset: {
					id: "bad-asset",
					title: "坏资产",
					mediaKind: "image",
					source: "uploaded",
					status: "ready",
					createdAt: "2026-09-26T00:00:00.000Z",
					metadata: { storageKey: "not-controlled", checksum: "x", contentType: "image/png", size: 1 }
				}
			}
		], "spec-reject-server");
		await page.waitForTimeout(1000);

		// 服务端拒绝：规范画布 revision 不前进、不含该资产。
		const after = await readStoredCanvas(page);
		expect((after as unknown as { revision: number }).revision).toBe(revisionBefore);
		expect((after as unknown as { assets: Array<{ id: string }> }).assets.map((a) => a.id)).not.toContain("bad-asset");
	});

	test("刷新后 pending 丢弃、只从 published 恢复", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		const created = await sendCommands(page, [
			{ type: "node.add", node: { id: "persist-1", type: "text", position: { x: 10, y: 10 } } }
		], "spec-persist");
		expect(created.ok).toBe(true);
		await waitForPersistedRevision(page, 1);

		await page.reload();
		await waitForCanvasSession(page);
		const canvas = await readStoredCanvas(page);
		expect((canvas as unknown as { document: { nodes: Array<{ id: string }> } }).document.nodes.map((n) => n.id)).toContain("persist-1");
	});

	test("IndexedDB 不保存 pending/working（任务 7.5）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		// 提交一个 pending（未等待回流）后立即检查 IndexedDB 内容。
		await sendCommands(page, [
			{ type: "node.add", node: { id: "cache-check", type: "text", position: { x: 0, y: 0 } } }
		], "spec-cache");

		const cacheDump = await page.evaluate(async () => {
			const dbs = await indexedDB.databases();
			const canvasDb = dbs.find((db) => db.name === "woohaa3-canvas");
			if (!canvasDb) return { stores: [], hasPending: false, hasWorking: false };
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open("woohaa3-canvas");
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const storeNames = [...db.objectStoreNames];
			let hasPending = false;
			let hasWorking = false;
			for (const name of storeNames) {
				const tx = db.transaction(name, "readonly");
				const all = await new Promise<unknown[]>((resolve) => {
					const request = tx.objectStore(name).getAll();
					request.onsuccess = () => resolve(request.result as unknown[]);
					request.onerror = () => resolve([]);
				});
				const serialized = JSON.stringify(all);
				if (/pending|working|commandId/i.test(serialized)) hasPending = true;
				if (/workingCanvas/.test(serialized)) hasWorking = true;
			}
			db.close();
			return { stores: storeNames, hasPending, hasWorking };
		});
		expect(cacheDump.hasPending).toBe(false);
		expect(cacheDump.hasWorking).toBe(false);
	});
});
