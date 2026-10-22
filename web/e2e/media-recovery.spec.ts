/**
 * 媒体与完整画布恢复的端到端验收（任务 7.3 / 9.8）。
 *
 * 覆盖：
 * - 通过应用自己的同源媒体接口上传 bytes → 拿到内容寻址 `storageKey` 与同源 url
 * - **IndexedDB 不含媒体 bytes**（库只应有 `canvases` + `settings`，JSON 里没有 base64/blob:）
 * - 刷新后仍能按稳定 `storageKey` 取回同一份 bytes
 * - 含 asset / nodeData / job 的完整画布能整体恢复
 * - COS（这里由内存替身承接）写入失败时**没有本地回退**，错误可诊断
 *
 * 说明：`asset` / `job` 记录目前没有对应的桥接命令（首版命令集只有节点/边/视口），
 * 所以本用例用**直接写入 IndexedDB** 的方式种下「资产写入路径将来会写成的那种记录」，
 * 再验证恢复契约。资产写入路径本身属于后续 change。
 */
import { expect, test } from "@playwright/test";
import { installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	seedYjsCanvas,
	uploadMedia,
	waitForCanvasSession,
	waitForPersistedRevision } from "./helpers.js";

const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];
const DEFAULT_CANVAS_ID = "woohaa3-default-canvas";

test.describe("媒体与完整恢复", () => {
	test("上传 → 同源 URL → 刷新后仍可按 storageKey 取回；库中不含媒体 bytes", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// —— 通过应用自己的媒体接口上传（与 Godot/浏览器用的是同一个入口）
		const uploaded = await uploadMedia(page, PNG_BYTES, "image/png");
		expect(uploaded.status).toBe(201);
		const storageKey = String(uploaded.body.storageKey);
		const url = String(uploaded.body.url);
		expect(storageKey).toMatch(/^sha256-[0-9a-f]{64}$/);
		expect(url).toBe(`/api/media/${storageKey}`);

		// —— 同源读取拿回同一份 bytes
		const firstRead = await page.evaluate(async (target) => {
			const response = await fetch(target);
			return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
		}, url);
		expect(firstRead.status).toBe(200);
		expect(firstRead.bytes).toEqual(PNG_BYTES);

		// —— 刷新后仍然可以按同一个 storageKey 取回（内容寻址 ⇒ 键稳定）
		await page.reload();
		await waitForCanvasSession(page);
		const afterReload = await page.evaluate(async (target) => {
			const response = await fetch(target);
			return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
		}, url);
		expect(afterReload.status).toBe(200);
		expect(afterReload.bytes).toEqual(PNG_BYTES);

		// —— IndexedDB 只应有结构化 store，且不含媒体 bytes
		const dbInfo = await page.evaluate(
			() =>
				new Promise<{ stores: string[]; json: string }>((resolve) => {
					const request = indexedDB.open("woohaa3-canvas");
					request.onsuccess = () => {
						const db = request.result;
						const stores = [...db.objectStoreNames].sort();
						const tx = db.transaction("yjsCacheUpdates", "readonly");
						const all = tx.objectStore("yjsCacheUpdates").getAll();
						all.onsuccess = () => {
							db.close();
							resolve({ stores, json: JSON.stringify(all.result ?? []) });
						};
					};
				})
		);
		// IndexedDB 只应有**结构化** store（Yjs cache 元数据与分片）。Yjs 是唯一持久化路径后，
		// 本地权威画布（canvases/settings）与 remote-cas 时代的 outbox/syncCaches 都已删除。
		expect(dbInfo.stores).toEqual(["yjsCacheMeta", "yjsCacheUpdates"]);
		expect(dbInfo.json).not.toContain("base64");
		expect(dbInfo.json).not.toContain("blob:");
		expect(dbInfo.json).not.toContain("data:");
		// bytes 不在库里：PNG 的魔数字节序列不应出现
		expect(dbInfo.json).not.toContain("137,80,78,71");
		expect(dbInfo.json).not.toMatch(/[?&](sign|Signature|q-signature)=/i);

		// 相同内容重复上传复用同一个键
		const again = await uploadMedia(page, PNG_BYTES, "image/png");
		expect(String(again.body.storageKey)).toBe(storageKey);
		expect(again.body.deduplicated).toBe(true);
	});

	test("含 asset / nodeData / job 的画布刷新后完整恢复", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 先真实上传一次，拿到 storageKey 与同源 url
		const uploaded = await uploadMedia(page, PNG_BYTES, "image/png");
		expect(uploaded.status).toBe(201);
		const storageKey = String(uploaded.body.storageKey);
		const url = String(uploaded.body.url);

		// 种下一份含 asset / job / nodeData 的**服务端权威画布**（Yjs 是唯一持久化路径）。
		const now = new Date().toISOString();
		await seedYjsCanvas(page, DEFAULT_CANVAS_ID, [], {
			canvas: {
				id: DEFAULT_CANVAS_ID,
				title: "E2E 画布",
				revision: 1,
				document: {
					schemaVersion: "asset-canvas-v1",
					nodes: [{ id: "node-e2e-1", type: "image", position: { x: 0, y: 0 } }],
					edges: [],
					updatedAt: now
				},
				nodeData: { "node-e2e-1": { taskKind: "image", outputAssetId: "asset-e2e-1" } },
				assets: [
					{
						id: "asset-e2e-1",
						nodeId: "node-e2e-1",
						title: "测试图",
						mediaKind: "image",
						source: "uploaded",
						status: "ready",
						url: url,
						createdAt: now,
						metadata: {
							storageKey,
							checksum: storageKey.replace("sha256-", ""),
							contentType: "image/png",
							size: 12
						}
					}
				],
				jobs: [{ id: "job-e2e-1", nodeId: "node-e2e-1", taskId: "task-1", status: "running", updatedAt: now }],
				updatedAt: now
			}
		});
		await page.goto("/");
		await waitForCanvasSession(page);
		// 种入的权威 revision=1 经 Yjs 回流是异步的；等它到达再断言，避免读到旧值。
		await waitForPersistedRevision(page, 1);

		const before = await readStoredCanvas(page);
		expect(before?.assets).toHaveLength(1);
		expect(before?.revision).toBe(1);

		// —— 刷新：应从服务端 Yjs 完整恢复 assets / jobs / nodeData
		await page.reload();
		await waitForCanvasSession(page);

		const after = await readStoredCanvas(page);
		expect(after?.revision).toBe(before!.revision);
		expect(after?.assets.map((asset) => asset.id)).toEqual(["asset-e2e-1"]);
		expect(after?.assets[0].metadata).toMatchObject({
			storageKey,
			contentType: "image/png",
			size: 12
		});
		expect(after?.assets[0].url).toBe(`/api/media/${storageKey}`);
		expect(after?.nodeData["node-e2e-1"]).toMatchObject({ outputAssetId: "asset-e2e-1" });

		// 恢复后媒体对象仍然可读（storageKey → bytes）
		const restored = await page.evaluate(async (target) => {
			const response = await fetch(target);
			return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
		}, String(after?.assets[0].url));
		expect(restored.status).toBe(200);
		expect(restored.bytes).toEqual(PNG_BYTES);
	});
});

test.describe("媒体写入失败（任务 9.8 的失败注入）", () => {
	test("注入存储 put 失败时没有本地回退，错误可诊断", async ({ page, request }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 打开故障注入：后续 put 一律失败
		const enabled = await request.post("/__e2e_fault__", { data: { mode: "put" } });
		expect((await enabled.json()).fault).toBe("put");

		try {
			const failed = await page.evaluate(async () => {
				const response = await fetch("/api/media", {
					method: "POST",
					headers: { "content-type": "image/png" },
					body: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
				});
				return { status: response.status, body: (await response.json()) as Record<string, unknown> };
			});

			// 明确的失败，且**没有**本地回退
			expect(failed.status).toBe(500);
			expect(failed.body.error).toBe("media-storage-failure");
			// 不回显存储层原始错误
			expect(JSON.stringify(failed.body)).not.toContain("injected");

			// 失败不产生任何可用的媒体引用：库里的画布没有新增 asset
			const canvas = await readStoredCanvas(page);
			expect(canvas?.assets ?? []).toEqual([]);
		} finally {
			await request.post("/__e2e_fault__", { data: { mode: "" } });
		}

		// 关闭故障后恢复正常
		const recovered = await uploadMedia(page, PNG_BYTES, "image/png");
		expect(recovered.status).toBe(201);
	});
});
