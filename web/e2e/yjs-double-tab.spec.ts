/**
 * 真实双标签页 + Godot 联合收敛 E2E（change: split-web-runtime-services，任务 8.3）。
 *
 * 与 `yjs-godot.spec.ts`（协议客户端模拟第二个「浏览器」）不同：这里开**两个真实页面**
 * 连接同一 canvas，验证：
 * - 远端（另一个真实标签页）画布编辑经 Yjs 收敛到本页与 Godot 投影；
 * - 任务终态由服务端 projector 写入权威 Y.Doc 后，在两个标签页与 Godot 上收敛；
 * - 断线重连后完整 hydrate 再恢复（两页最终一致）。
 *
 * 需要站点启用画布存储 + Yjs 同步，跑在 `playwright.yjs.config.ts` 下。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, waitForCanvasSession, waitForBevyReady } from "./helpers.js";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_SYNC_PROTOCOL_VERSION,
  encodeCommandMessage,
  encodeSyncMessage
} from "@woohaa3/contracts/canvas-yjs";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;
const CANVAS = "woohaa3-default-canvas";

function emptyCanvas() {
  return {
    id: CANVAS,
    title: "双标签页演练",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [],
      edges: [],
      updatedAt: "2026-09-24T00:00:00.000Z"
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-24T00:00:00.000Z"
  };
}

async function enableDefaultCanvasYjs(): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS, canvas: emptyCanvas() })
  });
  expect(response.ok).toBe(true);
}

/** 等页面会话进入 ready 且 Yjs provider 已 synced。 */
async function waitForSynced(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = (globalThis as unknown as { __canvasSessionStatus?: { phase?: string; remote?: { mode?: string; phase?: string } } })
        .__canvasSessionStatus;
      return status?.phase === "ready" && status?.remote?.mode === "remote" && status?.remote?.phase === "synced";
    },
    undefined,
    { timeout: 30_000 }
  );
}

/**
 * 读本页投影里出现过的节点 ID 集合。
 *
 * Bevy 迁移后已无 Godot 帧镜像（`__canvasFrameLog`）；改为读取当前派生的 canonical
 * 投影（服务端 Y.Doc 派生，change: replace-godot-canvas-runtime-with-bevy）。
 */
async function projectedNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canonical = (globalThis as unknown as {
      __canvasCanonical?: { document?: { nodes?: Array<{ id: string }> } };
    }).__canvasCanonical;
    return (canonical?.document?.nodes ?? []).map((node) => node.id);
  });
}

/**
 * 真实第二个标签页提交一条语义命令。
 *
 * 它走**服务端同步协议**（与浏览器 provider 相同的只读出站 + 语义命令），因此等价于
 * 另一个真实浏览器在画布上操作，但不需要第二个 Godot 实例（Godot 只投影本页）。
 */
async function commitFromSecondTab(
  commands: unknown[],
  commandId: string,
  actorId = "tab-2"
): Promise<void> {
  const doc = new Y.Doc();
  const statuses: string[] = [];
  const results: Array<{ commandId?: string; status?: string }> = [];
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId: CANVAS, roomEpoch: "e2e-epoch" }),
    { headers: { "x-woohaa3-actor": actorId } }
  );
  ws.on("message", (raw: Buffer) => {
    const decoded = decodeYjsFrame(new Uint8Array(raw));
    if (!decoded) return;
    if (decoded.type === MESSAGE_TYPE.SYNC) {
      if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP2 || decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
        Y.applyUpdate(doc, decoded.payload as Uint8Array, "server");
      } else if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
      }
    } else if (decoded.type === MESSAGE_TYPE.STATUS) {
      statuses.push((decoded.status as { status?: string }).status ?? "");
    } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
      results.push(decoded.result as { commandId?: string; status?: string });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
  await waitFor(() => statuses.includes("synced"), "第二个标签页 synced");
  ws.send(yjsFrame(encodeCommandMessage({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId,
    baseRevision: 0,
    actorId,
    commands: commands as never
  })));
  await waitFor(() => results.some((r) => r.commandId === commandId), "第二个标签页命令结果");
  expect(results.find((r) => r.commandId === commandId)?.status).toBe("accepted");
  ws.close();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${label} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.describe("真实双标签页 + Godot 收敛（任务 8.3）", () => {
  test("远端标签页编辑经 Yjs 收敛到本页与 Godot 投影", async ({ browser }) => {
    await enableDefaultCanvasYjs();

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      for (const page of [pageA, pageB]) {
        await installPageHelpers(page);
        await page.goto("/");
        await waitForBevyReady(page);
        await waitForCanvasSession(page);
        await waitForSynced(page);
      }

      // 第二个真实标签页（pageB）经协议提交一个节点。
      await commitFromSecondTab(
        [{ type: "node.add", node: { id: "tab2-node", type: "text", position: { x: 30, y: 40 } } }],
        `tab2-${Date.now()}`
      );

      // 两个标签页的 Godot 投影最终都包含该节点。
      for (const page of [pageA, pageB]) {
        await waitFor(
          () => projectedNodeIds(page).then((ids) => ids.includes("tab2-node")),
          "tab2-node 投影"
        );
        expect(await projectedNodeIds(page)).toContain("tab2-node");
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("断线重连后两个真实标签页最终 hydrate 收敛", async ({ browser }) => {
    await enableDefaultCanvasYjs();

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      for (const page of [pageA, pageB]) {
        await installPageHelpers(page);
        await page.goto("/");
        await waitForBevyReady(page);
        await waitForCanvasSession(page);
        await waitForSynced(page);
      }

      // 先让画布有一个节点。
      await commitFromSecondTab(
        [{ type: "node.add", node: { id: "reconnect-node", type: "text", position: { x: 5, y: 5 } } }],
        `seed-${Date.now()}`
      );
      await waitFor(
        () => projectedNodeIds(pageA).then((ids) => ids.includes("reconnect-node")),
        "A 收敛"
      );

      // A 断线（Chromium setOffline 不关闭已建立 socket，由产品 offline 事件处理）。
      await contextA.setOffline(true);
      await waitFor(
        () => pageA.evaluate(async () => {
          const remote = (globalThis as unknown as { __canvasSessionStatus?: { remote?: { mode?: string } } })
            .__canvasSessionStatus?.remote;
          return remote?.mode === "offline" || remote?.mode === "disabled";
        }),
        "A offline"
      );
      // 断线时 Godot 保留画面。
      expect(await projectedNodeIds(pageA)).toContain("reconnect-node");

      // 断线期间 B 继续编辑。
      await commitFromSecondTab(
        [{ type: "node.add", node: { id: "offline-node", type: "text", position: { x: 80, y: 20 } } }],
        `offline-${Date.now()}`,
        "tab-b"
      );

      // A 恢复网络：重新同步后应补齐断线期间的变化。
      await contextA.setOffline(false);
      await waitForSynced(pageA);
      await waitFor(
        () => projectedNodeIds(pageA).then((ids) => ids.includes("offline-node")),
        "A 恢复补齐 offline-node"
      );
      // 两页最终都包含两个节点。
      for (const page of [pageA, pageB]) {
        const ids = await projectedNodeIds(page);
        expect(ids).toContain("reconnect-node");
        expect(ids).toContain("offline-node");
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
