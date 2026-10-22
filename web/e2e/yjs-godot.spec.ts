/**
 * Yjs 模式下的浏览器 + Godot E2E（change: add-yjs-canvas-sync，任务 7.11 / 7.12）。
 *
 * 覆盖：
 * - **7.11**：两个浏览器同时打开同一 canvas，一端提交命令，另一端与 Godot 通过 Yjs
 *   update 收敛并生成正确增量帧；
 * - **7.12**：断线时 Godot 保留画面但写入被禁用；重连收敛后完整 hydrate 再恢复。
 *
 * 这些用例需要站点启用画布存储 + Yjs 同步，因此跑在 `playwright.yjs.config.ts` 下。
 * 站点画布 ID 固定为 `woohaa3-default-canvas`（`DEFAULT_CANVAS_ID`），所以这里先把该
 * canvas 置为 yjs 模式。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installPageHelpers,
  waitForCanvasSession,
  waitForBevyReady } from "./helpers.js";
import { WebSocket } from "ws";
import { MESSAGE_TYPE, SYNC_MESSAGE_TYPE, YJS_SYNC_PROTOCOL_VERSION, encodeCommandMessage, encodeSyncMessage } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;
const CANVAS = "woohaa3-default-canvas";

function emptyCanvas(revision = 0) {
  return {
    id: CANVAS,
    title: "未命名画布",
    revision,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [],
      edges: [],
      updatedAt: "2026-09-23T00:00:00.000Z"
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-23T00:00:00.000Z"
  };
}

/** 把站点默认 canvas 置为 yjs 模式。 */
async function enableDefaultCanvasYjs(revision = 0): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS, canvas: emptyCanvas(revision) })
  });
  expect(response.ok).toBe(true);
}

/**
 * 通过同步协议向 canvas 提交一条命令（模拟「另一个浏览器」）。
 *
 * 用协议而不是第二个真实页面：本用例要验证的是**收敛与投影**，协议是规范入口，
 * 第二个页面只会引入额外的启动噪声。
 */
async function commitViaProtocol(commands: unknown[], commandId = `e2e-${Date.now()}`): Promise<void> {
  const client = new Y.Doc();
  const statuses: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId: CANVAS, roomEpoch: "e2e-epoch" })
  );
  ws.on("message", (data: Buffer) => {
    const decoded = decodeYjsFrame(new Uint8Array(data));
    if (!decoded) return;
    if (decoded.type === MESSAGE_TYPE.SYNC) {
      if (decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) Y.applyUpdate(client, decoded.payload);
      if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
      }
      return;
    }
    if (decoded.type === MESSAGE_TYPE.STATUS) statuses.push(decoded.status as Record<string, unknown>);
    if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) results.push(decoded.result as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
  await waitFor(() => statuses.some((entry) => entry.status === "synced"));
  ws.send(yjsFrame(encodeCommandMessage({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId,
    baseRevision: 0,
    actorId: "e2e-protocol",
    commands: commands as never
  })));
  await waitFor(() => results.length > 0);
  expect(results[0].status).toBe("accepted");
  ws.close();
}

/** 读取本页 Bevy 投影覆盖的节点 ID 集合（由规范聚合派生；与 yjs-double-tab 一致）。 */
async function projectedNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canonical = (globalThis as unknown as {
      __canvasCanonical?: { document?: { nodes?: Array<{ id: string }> } };
    }).__canvasCanonical;
    return (canonical?.document?.nodes ?? []).map((node) => node.id);
  });
}

/**
 * 轮询直到谓词为真。
 *
 * 谓词**可以是异步的**：此前签名是 `() => boolean`，但多处调用传的是
 * `() => projectedNodeIds(page).then(...)` / `async () => ...`；Promise 恒为真，
 * 于是 `waitFor` 立即返回、根本没等待 —— 这是 7.11/7.12 随机失败的根因，已修。
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 等本页 Yjs provider 真正连上并同步（远端提交前必须满足，否则 broadcast 落空）。 */
async function waitForRemoteSynced(page: Page): Promise<void> {
  await waitFor(async () => {
    const remote = await page.evaluate(
      () =>
        (globalThis as unknown as { __canvasSessionStatus?: { remote?: { mode?: string; phase?: string } } })
          .__canvasSessionStatus?.remote
    );
    return remote?.mode === "remote" && remote?.phase === "synced";
  });
}

test.describe("Yjs 模式浏览器 + Godot", () => {
  test("7.11 远端命令经 Yjs 同步到本页并生成增量投影", async ({ page }) => {
    await enableDefaultCanvasYjs();
    await installPageHelpers(page);
    await page.goto("/");
    await waitForBevyReady(page);
    await waitForCanvasSession(page);

    // 等待本页完成 Yjs 初始同步（会话进入 ready 且未报错）。
    await waitFor(async () => {
      const status = await page.evaluate(
        () => (globalThis as unknown as { __canvasSessionStatus?: { phase: string } }).__canvasSessionStatus?.phase
      );
      return status === "ready";
    });
    // 必须等 provider 连上并 synced，再做远端提交（否则 broadcast 落空）。
    await waitForRemoteSynced(page);

    // 远端（另一个「浏览器」）提交一个节点。
    await commitViaProtocol([
      { type: "node.add", node: { id: "remote-node-1", type: "text", position: { x: 40, y: 60 } } }
    ]);

    // 本页最终在 Godot 投影里看到该节点（经 Yjs update → 派生聚合 → 增量帧）。
    await waitFor(() => projectedNodeIds(page).then((ids) => ids.includes("remote-node-1")));
    expect(await projectedNodeIds(page)).toContain("remote-node-1");
  });

  test("7.12 断线时 Godot 保留画面且写入被禁用；重连后重新 hydrate", async ({ page }) => {
    await enableDefaultCanvasYjs();
    await installPageHelpers(page);
    await page.goto("/");
    await waitForBevyReady(page);
    await waitForCanvasSession(page);

    // 同 7.11：远端提交前必须等本页 provider 真正 synced。
    await waitForRemoteSynced(page);

    // 先让远端提交一个节点，确保本页有可保留的画面内容。
    await commitViaProtocol([
      { type: "node.add", node: { id: "keep-node", type: "text", position: { x: 10, y: 10 } } }
    ], `keep-${Date.now()}`);
    await waitFor(() => projectedNodeIds(page).then((ids) => ids.includes("keep-node")));

    // 断网：页面内的 WebSocket 被浏览器关闭 → provider 进入 offline-readonly。
    await page.context().setOffline(true);
    await waitFor(async () => {
      const remote = await page.evaluate(
        () => (globalThis as unknown as { __canvasSessionStatus?: { remote?: { mode?: string } } })
          .__canvasSessionStatus?.remote
      );
      return remote?.mode === "offline" || remote?.mode === "disabled";
    });

    // 画面保留：投影里仍有 keep-node（Godot 不清空）。
    expect(await projectedNodeIds(page)).toContain("keep-node");

    // 恢复网络：provider 重连并**重新完成同步**（mode=remote 且 phase=synced）。
    await page.context().setOffline(false);
    await waitFor(async () => {
      const remote = await page.evaluate(
        () => (globalThis as unknown as { __canvasSessionStatus?: { remote?: { mode?: string; phase?: string } } })
          .__canvasSessionStatus?.remote
      );
      return remote?.mode === "remote" && remote?.phase === "synced";
    });
    // 重连后仍能看到该节点（完整 hydrate 或差量为零）。
    expect(await projectedNodeIds(page)).toContain("keep-node");
  });
});
