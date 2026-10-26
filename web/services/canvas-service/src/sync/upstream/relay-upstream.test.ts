/**
 * 远端同步上游：两个本地 sidecar（各自的 room registry + 存储）经同一个中继同步。
 *
 * 中继是按 `woohaa.canvas.v1` 会话协议实现的进程内假实现（只存取不透明字节、ack 发起方、
 * 广播给其它连接），与闭源 Go 中继的对外行为一致。
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import {
  ClientFrameSchema,
  ServerFrameSchema
} from "../../../../../../api/gen/es/woohaa/canvas/v1/session_pb.js";
import { InMemoryYjsDocumentRepository } from "../in-memory-yjs-repository.js";
import { CanvasRoomRegistry } from "../room-registry.js";
import type { ExternalUpdateResult, RoomBroadcast } from "../room-types.js";
import { createSyncUpstream, type SyncUpstream, type SyncUpstreamEvent } from "./relay-upstream.js";

const NOW = "2026-10-15T00:00:00.000Z";
const CANVAS = "canvas-upstream";

type FakeRelay = {
  url: string;
  records: Uint8Array[];
  /** 收到的每一帧 Hello 的创建意图，用于验证"首推声明、只读不声明"。 */
  hellos: boolean[];
  /** 与 hellos 对齐的 Hello.title（空串表示没带），用于验证画布名随会话上报。 */
  titles: string[];
  /** 收到的 ClientTitle 帧（改名实时同步），按到达顺序。 */
  declaredTitles: string[];
  /** 收到的 Hello.client 自报元数据，按到达顺序（观测用，旧服务端忽略）。 */
  clientInfos: Array<{ name: string; version: string; platform: string }>;
  /** 握手请求里的 User-Agent，按到达顺序。 */
  userAgents: string[];
  /** 建过的 WebSocket 连接总数（含快照读取），用于断言"没有重连"。 */
  readonly connections: number;
  /** 断开全部连接，并在 `resume()` 前拒绝新连接。 */
  pause(): void;
  resume(): void;
  close(): Promise<void>;
};

async function startFakeRelay(options: { canWrite?: boolean; closeUpdateWith?: number } = {}): Promise<FakeRelay> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  let connections = 0;
  const records: Uint8Array[] = [];
  const hellos: boolean[] = [];
  const titles: string[] = [];
  const declaredTitles: string[] = [];
  const clientInfos: Array<{ name: string; version: string; platform: string }> = [];
  const userAgents: string[] = [];
  const conns = new Set<ServerSocket>();
  let paused = false;
  const send = (ws: ServerSocket, init: MessageInitShape<typeof ServerFrameSchema>) =>
    ws.send(toBinary(ServerFrameSchema, create(ServerFrameSchema, init)));

  wss.on("connection", (ws, req) => {
    connections += 1;
    // 观测端用握手 UA 认客户端：本机宿主显式设置，浏览器默认值也照录。
    userAgents.push(String(req.headers["user-agent"] ?? ""));
    if (paused) {
      ws.close(1013, "paused");
      return;
    }
    let joined = false;
    ws.on("message", (data: Buffer) => {
      const frame = fromBinary(ClientFrameSchema, new Uint8Array(data)).frame;
      if (frame.case === "title") {
        // 标题帧不产生记录、也不需要 ack：只记录到达顺序，供用例断言。
        declaredTitles.push(frame.value.title);
        return;
      }
      if (frame.case === "hello") {
        hellos.push(frame.value.createIfMissing);
        titles.push(frame.value.title);
        clientInfos.push({
          name: frame.value.client?.name ?? "",
          version: frame.value.client?.version ?? "",
          platform: frame.value.client?.platform ?? ""
        });
        const after = frame.value.roomEpoch === "relay-epoch" ? Number(frame.value.afterSeq) : 0;
        send(ws, { frame: { case: "welcome", value: { version: 1, roomEpoch: "relay-epoch", actorId: "t", canWrite: options.canWrite ?? true } } });
        records.forEach((update, index) => {
          if (index + 1 > after) send(ws, { frame: { case: "update", value: { seq: BigInt(index + 1), update } } });
        });
        send(ws, { frame: { case: "synced", value: { seq: BigInt(records.length) } } });
        joined = true;
        conns.add(ws);
        return;
      }
      if (frame.case === "update" && joined) {
        if (!(options.canWrite ?? true)) return;
        if (options.closeUpdateWith !== undefined) {
          // 模拟服务端读上限：收到超大帧后直接以 1009 关闭，不落库、不 ack。
          ws.close(options.closeUpdateWith, "read limited at 1048576 bytes");
          return;
        }
        records.push(frame.value.update);
        const seq = BigInt(records.length);
        send(ws, { frame: { case: "ack", value: { clientSeq: frame.value.clientSeq, seq } } });
        for (const other of conns) {
          if (other !== ws) send(other, { frame: { case: "update", value: { seq, update: frame.value.update } } });
        }
      }
    });
    ws.on("close", () => conns.delete(ws));
  });

  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    records,
    hellos,
    titles,
    declaredTitles,
    clientInfos,
    userAgents,
    get connections() {
      return connections;
    },
    pause() {
      paused = true;
      for (const ws of wss.clients) ws.terminate();
    },
    resume() {
      paused = false;
    },
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    })
  };
}

type Sidecar = {
  registry: CanvasRoomRegistry;
  upstream: SyncUpstream;
  broadcasts: Array<Parameters<RoomBroadcast>[0]>;
  /** 运行中切换这张画布的上游目标（等价于「同步远端」/「回到本地」）。 */
  setTarget: (url: string | null) => Promise<void>;
};

function startSidecar(
  relayUrl: string | null,
  bootstrap: ServerCanvas | null,
  clientInfo?: { name: string; version: string; platform: string },
  overrides: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    healthyLinkMs?: number;
    logger?: (event: SyncUpstreamEvent) => void;
  } = {}
): Sidecar {
  let target: string | null = relayUrl;
  const upstream = createSyncUpstream(
    async () => (target ? { url: target } : null),
    {
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      snapshotTimeoutMs: 1_000,
      ...(clientInfo ? { clientInfo } : {}),
      ...overrides
    }
  );
  const broadcasts: Sidecar["broadcasts"] = [];
  const registry = new CanvasRoomRegistry({
    repository: new InMemoryYjsDocumentRepository(),
    now: () => NOW,
    verifyAssets: false,
    broadcast: (input) => {
      broadcasts.push(input);
      upstream.publish(input);
    },
    onClientAcquired: (room) => upstream.attach(room),
    seedFromUpstream: (canvasId) => upstream.fetchSnapshot(canvasId),
    bootstrap: async () => bootstrap
  });
  return {
    registry,
    upstream,
    broadcasts,
    async setTarget(url) {
      target = url;
      await upstream.refresh();
    }
  };
}

function addNode(id: string, commandId: string) {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId,
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "node.add" as const, node: { id, type: "image", position: { x: 0, y: 0 } } }]
  };
}

function setTitle(title: string) {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: `title-${title}`,
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "canvas.setTitle" as const, title }]
  };
}

/**
 * 以**客户端**身份打开画布（等价于浏览器进页面）。
 *
 * 上游挂载点已从「room 创建」移到「第一次被客户端持有」：内部消费者调
 * `registry.resolve()` 只拿文档、不挂链路（任务对账加载的画布不该推给远端）。
 * 因此用例里凡是要验证同步的，都必须走 acquire。
 */
const openLeases: Array<{ release: () => void }> = [];
async function open(sidecar: Sidecar, canvasId: string = CANVAS) {
  const lease = await sidecar.registry.acquire(canvasId);
  openLeases.push(lease);
  return lease.room;
}

async function nodeIds(sidecar: Sidecar): Promise<string[]> {
  const exported = (await open(sidecar)).exportCanvas();
  return exported.ok ? exported.canvas.document.nodes.map((node) => node.id).sort() : [];
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const lease of openLeases.splice(0)) lease.release();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { canWrite?: boolean } = {}) {
  const relay = await startFakeRelay(options);
  cleanups.push(() => relay.close());
  const spawn = (
    bootstrap: ServerCanvas | null,
    options: { local?: boolean; clientInfo?: { name: string; version: string; platform: string } } = {}
  ) => {
    const sidecar = startSidecar(options.local ? null : relay.url, bootstrap, options.clientInfo);
    cleanups.push(async () => {
      await sidecar.registry.destroyAll();
      sidecar.upstream.close();
    });
    return sidecar;
  };
  return { relay, spawn };
}

describe("经中继同步的两个本地 sidecar", () => {
  it("运行中在纯本地与远端之间切换", async () => {
    const { relay, spawn } = await setup();
    const a = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW), { local: true });
    const roomA = await open(a);
    expect((await roomA.submit(addNode("before-switch", "a-1"))).ok).toBe(true);
    expect(a.upstream.linkState(CANVAS)).toBeNull();
    expect(relay.records).toHaveLength(0);

    await a.setTarget(relay.url);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced" && relay.records.length === 1);
    const b = spawn(null);
    await open(b);
    expect(await nodeIds(b)).toEqual(["before-switch"]);
    expect((await (await open(b)).submit(addNode("from-b", "b-1"))).ok).toBe(true);
    await waitFor(async () => (await nodeIds(a)).includes("from-b"));

    await a.setTarget(null);
    expect(a.upstream.linkState(CANVAS)).toBeNull();
    expect((await (await open(b)).submit(addNode("after-local", "b-2"))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await nodeIds(a)).not.toContain("after-local");
  });

  it("新机器本地没有画布时从中继初始化，之后双向同步命令结果", async () => {
    const { relay, spawn } = await setup();
    const a = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    const roomA = await open(a);
    // 同步完成前的命令与初始状态合并成一次补推。
    expect((await roomA.submit(addNode("from-a", "a-1"))).ok).toBe(true);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced" && relay.records.length === 1);

    // B 的结构化存储里没有这个画布：只能从中继取。
    const b = spawn(null);
    const roomB = await open(b);
    expect(roomB.roomState).toBe("ready");
    expect(await nodeIds(b)).toEqual(["from-a"]);

    expect((await roomB.submit(addNode("from-b", "b-1"))).ok).toBe(true);
    await waitFor(async () => (await nodeIds(a)).includes("from-b"));
    expect((await roomA.submit(addNode("from-a-2", "a-2"))).ok).toBe(true);
    await waitFor(async () => (await nodeIds(b)).includes("from-a-2"));
    expect(await nodeIds(a)).toEqual(await nodeIds(b));

    // 远端合入的 update 会广播给本机浏览器，但不会被回推给中继。
    expect(b.broadcasts.some((entry) => entry.origin === "upstream")).toBe(true);
    const recordsBefore = relay.records.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay.records.length).toBe(recordsBefore);
  });

  it("断线期间的本机命令在重连后补推", async () => {
    const { relay, spawn } = await setup();
    const a = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    const roomA = await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    const b = spawn(null);
    await open(b);
    await waitFor(() => b.upstream.linkState(CANVAS)?.phase === "synced");

    relay.pause();
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase !== "synced");
    expect((await roomA.submit(addNode("offline", "a-offline"))).ok).toBe(true);
    expect(await nodeIds(b)).toEqual([]);

    relay.resume();
    await waitFor(async () => (await nodeIds(b)).includes("offline"));
  });

  it("只读令牌不推送本机修改", async () => {
    const { relay, spawn } = await setup({ canWrite: false });
    const a = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    const roomA = await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    expect(a.upstream.linkState(CANVAS)?.canWrite).toBe(false);
    expect((await roomA.submit(addNode("local-only", "a-1"))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay.records).toHaveLength(0);
  });
});

describe("本地创建、远端登记", () => {
  /**
   * 这套部署是本地优先：画布由客户端在本地创建（id 由客户端生成），第一次同步时
   * 才把 id 带到远端。远端据此登记画布并把推送者记为作者，因此客户端必须在
   * "手里没有任何这条中继线路的记录"时**显式声明**创建意图。
   */
  it("首次推送声明创建意图，读取快照与重连都不声明", async () => {
    const { relay, spawn } = await setup();
    const a = spawn({ ...createEmptyWoohaa3ServerCanvas(CANVAS, NOW), title: "片场 A" });
    await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced" && relay.records.length === 1);

    // 第一帧来自 seedFromUpstream 的读取（本地无文档时先问远端），它必须是 false：
    // 一次读取若声明创建意图，就会变成一次认领。
    // 第二帧是真正的同步连接，那是本机第一次把内容推给远端，必须是 true。
    expect(relay.hellos[0]).toBe(false);
    expect(relay.hellos[1]).toBe(true);
    expect(relay.hellos.filter(Boolean)).toHaveLength(1);
    // 画布名只在同步会话里声明；只读快照不带标题（它不登记、也不该改任何展示字段）。
    expect(relay.titles[1]).toBe("片场 A");
    expect(relay.titles[0]).toBe("");

    // 新机器本地没有画布，只读取：不产生新的创建意图。
    const b = spawn(null);
    await open(b);
    expect(relay.hellos.filter(Boolean)).toHaveLength(1);
  });

  it("重连时不再声明创建意图", async () => {
    const { relay, spawn } = await setup();
    const a = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    expect(relay.hellos.filter(Boolean)).toHaveLength(1);

    relay.pause();
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "offline");
    relay.resume();
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    // 重连带上了 epoch 与游标：这张画布早就在同步，不该再登记一次。
    expect(relay.hellos.filter(Boolean)).toHaveLength(1);
  });
});

describe("按画布启用同步", () => {
  /**
   * 登录远端不等于每张本地画布都上传：解析入口按 canvasId 回答，只有返回链路的画布才会
   * 连中继。这里用两张画布验证「一张启用、一张保持纯本地」，并在运行中启用第二张。
   */
  it("只给被显式启用的画布建链路，运行中启用另一张只影响它", async () => {
    const { relay } = await setup();
    const doc = new Y.Doc();
    const room = (canvasId: string) => ({
      canvasId,
      // 这张用例只关心"哪些画布建了链路"，标题固定为空即可。
      title: () => "",
      encodeStateVector: () => Y.encodeStateVector(doc),
      encodeDiff: (stateVector: Uint8Array) => Y.encodeStateAsUpdate(doc, stateVector),
      applyExternalUpdate: async (): Promise<ExternalUpdateResult> => ({ ok: true, changed: false, revision: 0 })
    });
    // 模拟扩展：只有用户点过「同步远端」的画布才返回链路。
    const enabled = new Set<string>(["remote-canvas"]);
    const upstream = createSyncUpstream(
      async (canvasId) => (enabled.has(canvasId) ? { url: relay.url } : null),
      { reconnectBaseMs: 10, reconnectMaxMs: 20, snapshotTimeoutMs: 1_000 }
    );
    cleanups.push(() => upstream.close());

    const disposeLocal = upstream.attach(room("local-canvas"));
    cleanups.push(disposeLocal);
    const disposeRemote = upstream.attach(room("remote-canvas"));
    cleanups.push(disposeRemote);

    await waitFor(() => upstream.linkState("remote-canvas")?.phase === "synced");
    expect(upstream.linkState("local-canvas")).toBeNull();

    // 运行中显式启用另一张：只重建这一张的链路。
    enabled.add("local-canvas");
    await upstream.refresh();
    await waitFor(() => upstream.linkState("local-canvas")?.phase === "synced");
    expect(upstream.linkState("remote-canvas")?.phase).toBe("synced");
  });

  it("同步完成后声明标题，改名后实时同步给服务端（中继）", async () => {
    const { relay, spawn } = await setup();
    const a = spawn({ ...createEmptyWoohaa3ServerCanvas(CANVAS, NOW), title: "旧名字" });
    const room = await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    // 首次同步完成就声明当前标题：服务端不解析 Yjs，只能靠这次声明拿到展示名。
    await waitFor(() => relay.declaredTitles.at(-1) === "旧名字");

    // 改名走画布命令（published meta.title 前进），随后应把新标题再声明一次。
    expect((await room.submit(setTitle("新名字"))).ok).toBe(true);
    await waitFor(() => relay.declaredTitles.at(-1) === "新名字");
    expect(relay.declaredTitles).toContain("旧名字");
  });
});

describe("客户端自报元数据（观测用）", () => {
  /**
   * 管理端调试通道要回答"谁、什么版本连上来的"。这些信息不参与同步与授权，
   * 但必须真的随握手送到服务端：Hello.client + 握手 UA 两处都要有。
   */
  it("Hello 带 name/version/platform，握手请求带对应 UA", async () => {
    const { relay, spawn } = await setup();
    const sidecar = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW), {
      clientInfo: { name: "woohaa3-host", version: "9.9.9-test", platform: "test-os" }
    });
    // 读取 room 才会建立上游链路（以及首次快照读取）。
    await open(sidecar);

    // 首次读取快照与后续链路至少有一次 Hello；两种情况都应带同一份元数据。
    await waitFor(() => relay.clientInfos.length > 0);
    expect(relay.clientInfos[0]).toEqual({
      name: "woohaa3-host",
      version: "9.9.9-test",
      platform: "test-os"
    });
    expect(relay.userAgents[0]).toBe("woohaa3-host/9.9.9-test test-os");
    // 所有连接（快照 + 链路）用同一份描述，不会出现"某条连接报别的版本"。
    for (const info of relay.clientInfos) {
      expect(info).toEqual(relay.clientInfos[0]);
    }
    for (const userAgent of relay.userAgents) {
      expect(userAgent).toBe(relay.userAgents[0]);
    }
  });

  it("缺省用本包版本与当前平台，不编造空版本", async () => {
    const { relay, spawn } = await setup();
    const sidecar = spawn(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    await open(sidecar);
    await waitFor(() => relay.clientInfos.length > 0);
    const info = relay.clientInfos[0]!;
    // 名称与平台总是有值；版本来自 package.json 或 WOOHAA3_APP_VERSION，不会为空。
    expect(info.name).toBe("woohaa3-host");
    expect(info.version).not.toBe("");
    expect(info.platform).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("断线重连的退避与容量型失败", () => {
  /**
   * 2026-10-21 的现场退化：服务端先发 Synced、再读入站帧，单帧超过读上限时连接在
   * synced 之后才以 1009 断开。客户端若把它当普通断线，就会以固定基线无休止重连，
   * 一次次重发同一份超大文档（现场 81 次/分钟、13 分钟零进度）。
   */
  it("服务端以 1009 关闭时进入失败态并停止重连", async () => {
    const relay = await startFakeRelay({ closeUpdateWith: 1009 });
    cleanups.push(() => relay.close());
    const a = startSidecar(relay.url, createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    cleanups.push(async () => {
      await a.registry.destroyAll();
      a.upstream.close();
    });

    await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "failed");
    expect(a.upstream.linkState(CANVAS)?.error).toContain("接收上限");

    // 失败后不再建新连接：同一份文档重发只会再撞一次上限。
    const settled = relay.connections;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(relay.connections).toBe(settled);

    // 但 failed 不是终态：refresh 允许再试一次（服务端上限可能已经调大）。
    await a.upstream.refresh();
    await waitFor(() => relay.connections > settled);
  });

  it("刚连上就断不重置退避，活过健康期后退避归零", async () => {
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    const events: SyncUpstreamEvent[] = [];
    const a = startSidecar(relay.url, createEmptyWoohaa3ServerCanvas(CANVAS, NOW), undefined, {
      reconnectBaseMs: 20,
      reconnectMaxMs: 80,
      healthyLinkMs: 40,
      logger: (event) => events.push(event)
    });
    cleanups.push(async () => {
      await a.registry.destroyAll();
      a.upstream.close();
    });
    const delays = () =>
      events
        .filter((event) => event.event === "sync-upstream-reconnect")
        .map((event) => Number(/retry in (\d+)ms/.exec(event.message ?? "")?.[1] ?? 0));

    await open(a);
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");

    // 每次都是"刚连上就被踢"：退避必须递增，而不是固定回到基线。
    relay.pause();
    await waitFor(() => delays().length >= 3);
    expect(delays().slice(0, 3)).toEqual([20, 40, 80]);

    // 恢复后这条链路活过 healthyLinkMs：下一次断开应回到基线。
    relay.resume();
    await waitFor(() => a.upstream.linkState(CANVAS)?.phase === "synced");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = delays().length;
    relay.pause();
    await waitFor(() => delays().length > before);
    expect(delays()[before]).toBe(20);
  });
});

describe("远端归属的持久记录（宿主注入）", () => {
  /**
   * 归属是"字节写进哪个后端"的事实，不是"此刻连没连上"：持久记录是宿主重启后
   * 存储层仍然能选对后端的唯一依据。这里用一个内存实现观察画布服务往记录里写了什么。
   */
  function memoryOwnership(seeded: string[] = []) {
    const remembered: string[] = [];
    const forgotten: string[] = [];
    const store = {
      initial: () => [...seeded],
      remember: (canvasId: string) => {
        remembered.push(canvasId);
        if (!seeded.includes(canvasId)) seeded.push(canvasId);
      },
      forget: (canvasId: string) => {
        forgotten.push(canvasId);
        const index = seeded.indexOf(canvasId);
        if (index >= 0) seeded.splice(index, 1);
      }
    };
    return { store, remembered, forgotten };
  }

  /** 只关心归属的假 room：不需要真的能导出文档。 */
  function quietRoom(canvasId: string) {
    const doc = new Y.Doc();
    return {
      canvasId,
      title: () => "",
      encodeStateVector: () => Y.encodeStateVector(doc),
      encodeDiff: (stateVector: Uint8Array) => Y.encodeStateAsUpdate(doc, stateVector),
      applyExternalUpdate: async (): Promise<ExternalUpdateResult> => ({ ok: true, changed: false, revision: 0 })
    };
  }

  it("启动时把持久记录当作已有归属：没有链路也仍然算远端画布", () => {
    const ownership = memoryOwnership(["canvas-seeded"]);
    const upstream = createSyncUpstream(async () => null, { ownership: ownership.store });
    cleanups.push(() => upstream.close());

    expect(upstream.remoteCanvasIds()).toEqual(["canvas-seeded"]);
    expect(upstream.linkedCanvasIds()).toEqual([]);
  });

  it("解析到远端配置就写入持久记录；之后解析为 null 也不收回", async () => {
    const { relay } = await setup();
    const ownership = memoryOwnership();
    let enabled = true;
    const upstream = createSyncUpstream(
      async () => (enabled ? { url: relay.url } : null),
      { reconnectBaseMs: 10, reconnectMaxMs: 20, ownership: ownership.store }
    );
    cleanups.push(() => upstream.close());
    cleanups.push(upstream.attach(quietRoom("canvas-owned")));

    await waitFor(() => ownership.remembered.includes("canvas-owned"));
    enabled = false;
    await upstream.refresh();
    await waitFor(() => upstream.linkState("canvas-owned") === null);

    // 停同步只断链路，不收回归属：字节已经在托管存储里，下次读还得去那里找。
    expect(ownership.forgotten).toEqual([]);
    expect(upstream.remoteCanvasIds()).toContain("canvas-owned");
  });

  /**
   * 2026-10-26 现场：浏览器在扩展注册 `canvas-upstream` capability 之前就重连并建好房间，
   * 首次解析必然拿不到链路；房间又被页面占着不会重新 attach，于是这张画布永久停在
   * 「没有上游链路」。刷新页面与重启宿主都会重演同一个竞态——只有重试能自愈。
   */
  /**
   * 2026-10-26 第二个现场：启动期任务对账会为「用户根本没打开」的画布加载 room，
   * 如果那时就挂上游，远端会看到好几张画布同时「有变化」（管理端「最近变化」被一起刷新）。
   * 上游归「第一次被客户端持有」所有，内部消费者只读写文档。
   */
  it("内部消费者 resolve() 加载 room 不挂上游；客户端打开后才挂", async () => {
    const { relay, spawn } = await setup();
    const sidecar = spawn(null);

    // 等价于任务对账/节点历史：只拿文档。
    await sidecar.registry.resolve(CANVAS);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sidecar.upstream.linkedCanvasIds()).toEqual([]);
    // 允许 seed 读取（本地没有文档时要从上游取一次），但**不能有任何推送**。
    expect(relay.records).toEqual([]);

    // 等价于浏览器进入这张画布。
    await open(sidecar);
    await waitFor(() => sidecar.upstream.linkedCanvasIds().includes(CANVAS));
    await waitFor(() => relay.connections === 1);
  });

  it("启动竞态：首次解析拿不到提供者，退避重试后自动建链", async () => {
    const { relay } = await setup();
    const ownership = memoryOwnership(["canvas-race"]);
    let calls = 0;
    const upstream = createSyncUpstream(
      async () => {
        calls += 1;
        return calls === 1 ? null : { url: relay.url };
      },
      { reconnectBaseMs: 10, reconnectMaxMs: 20, resolveRetryBaseMs: 20, ownership: ownership.store }
    );
    cleanups.push(() => upstream.close());
    cleanups.push(upstream.attach(quietRoom("canvas-race")));

    await waitFor(() => upstream.linkedCanvasIds().includes("canvas-race"));
    expect(calls).toBeGreaterThanOrEqual(2);
    // 归属本来就来自持久记录，重试成功不应再重复写盘。
    expect(ownership.remembered).not.toContain("canvas-race");
  });

  it("纯本地画布解析为 null 时不重试（没有归属就不该烧定时器）", async () => {
    let calls = 0;
    const upstream = createSyncUpstream(async () => {
      calls += 1;
      return null;
    }, { resolveRetryBaseMs: 10 });
    cleanups.push(() => upstream.close());
    cleanups.push(upstream.attach(quietRoom("canvas-local-only")));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
  });

  it("画布被删除才收回归属（forgetOwnership 同时落盘）", () => {
    const ownership = memoryOwnership(["canvas-1"]);
    const upstream = createSyncUpstream(async () => null, { ownership: ownership.store });
    cleanups.push(() => upstream.close());

    upstream.forgetOwnership("canvas-1");
    expect(ownership.forgotten).toEqual(["canvas-1"]);
    expect(upstream.remoteCanvasIds()).toEqual([]);
  });
});

describe("目录补记归属（登录/启动后 catalog 里已有的画布）", () => {
  it("rememberOwnership 立刻进 remoteCanvasIds 并写入持久记录", () => {
    const seeded: string[] = [];
    const remembered: string[] = [];
    const upstream = createSyncUpstream(async () => null, {
      ownership: {
        initial: () => [...seeded],
        remember: (canvasId: string) => {
          remembered.push(canvasId);
          seeded.push(canvasId);
        },
        forget: () => undefined
      }
    });
    cleanups.push(() => upstream.close());

    // 目录来源给出的画布：还没打开、也没有链路，但字节就在托管存储里。
    upstream.rememberOwnership("canvas-in-catalog");
    expect(upstream.remoteCanvasIds()).toEqual(["canvas-in-catalog"]);
    expect(remembered).toEqual(["canvas-in-catalog"]);

    // 重复补记不重复写盘（每次 refresh 都会列一遍目录）。
    upstream.rememberOwnership("canvas-in-catalog");
    expect(remembered).toEqual(["canvas-in-catalog"]);
  });
});
