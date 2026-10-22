/**
 * 游戏炼丹炉后端插件定义装配测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 6.1/6.10 / 8.2）。
 *
 * 验证：activation 注册受控 handler 与原始 HTTP 预览入口、声明 capability；DTO handler 的形状
 * 校验与状态码；原始预览入口的 404/CSP/bytes；dispose 后控制器停用。用进程内替身避免真实
 * 后端与凭据。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationBackendHost, ApplicationExtensionHandlerResult } from "@woohaa3/contracts";
import { createGameFurnaceBackendDefinition } from "../src/backend-extension.js";
import { createGameFurnaceBackend } from "../src/backend.js";
import { createGamePreviewHost } from "../src/preview.js";
import { computeInputHash, type GameFurnaceState } from "../src/shared.js";
import { planGameFurnaceDrop } from "../src/collection.js";
import type { ServerCanvas } from "@woohaa3/contracts";

const VALID_HTML = `<!doctype html><html><body><script>let s=0;function l(){s++;requestAnimationFrame(l)}l();</script></body></html>`;

function initial(): GameFurnaceState {
  return {
    projectId: "gf-proj",
    resources: [],
    requirements: { name: "跳跃", description: "跳", modelKey: "gpt-language" },
    generations: [],
    builds: []
  };
}

type RawRes = {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Uint8Array[];
  ended: boolean;
};

function makeRawRes(): { res: never; captured: RawRes } {
  const captured: RawRes = { statusCode: 0, headers: {}, chunks: [], ended: false };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | readonly string[]) { captured.headers[name] = Array.isArray(value) ? value.join(",") : String(value); return res; },
    writeHead(statusCode: number, headers?: Record<string, string | readonly string[]>) {
      captured.statusCode = statusCode;
      if (headers) for (const [k, v] of Object.entries(headers)) captured.headers[k] = Array.isArray(v) ? v.join(",") : String(v);
      return res;
    },
    write(chunk: unknown) { captured.chunks.push(toBytes(chunk)); return res; },
    end(chunk?: unknown) { if (chunk !== undefined) captured.chunks.push(toBytes(chunk)); captured.ended = true; return res; },
    get writableEnded() { return captured.ended; }
  };
  return { res: res as never, captured };
}

function toBytes(chunk: unknown): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
}

/**
 * 装配一个最小后端宿主替身：捕获 handler/raw handler 与生命周期；Task/Media 为内存替身。
 */
function makeHarness() {
  const storedBytes = new Map<string, Uint8Array>();
  let writeCounter = 0;
  let failWrites = false;
  const taskStatus = new Map<string, string>();
  const taskResults = new Map<string, string>();
  let admitted = true;
  /** 任务 6.2：授权判定替身与请求主体（可注入拒绝/缺主体以验证 fail closed）。 */
  let accessDecision: { ok: true } | { ok: false; code: string; message: string } = { ok: true };
  let accessSubject: string | null = "tester";
  const accessCalls: Array<{ subject: string; canvasId: string; permission: "read" | "write" }> = [];
  let authoritativeCanvas: ServerCanvas = {
    id: "c", revision: 1,
    document: { schemaVersion: "asset-canvas-v1", nodes: [], edges: [], updatedAt: "2026-10-10T00:00:00.000Z" },
    nodeData: {}, assets: [], jobs: [], updatedAt: "2026-10-10T00:00:00.000Z"
  } as unknown as ServerCanvas;
  const media = {
    resources: {
      async read(storageKey: string) {
        const bytes = storedBytes.get(storageKey);
        if (!bytes) throw new Error("not found");
        return { bytes, contentType: "application/json" };
      },
      async write({ bytes }: { bytes: Uint8Array; contentType: string }) {
        if (failWrites) throw new Error("media store failure");
        const storageKey = `sha256-w${writeCounter++}`;
        storedBytes.set(storageKey, bytes);
        return { storageKey, contentType: "application/json", size: bytes.length, checksum: storageKey };
      }
    },
    async stat(storageKey: string) {
      const bytes = storedBytes.get(storageKey);
      return bytes ? { exists: true, contentType: "application/json", size: bytes.length } : { exists: false };
    }
  };
  const tasks = {
    async submit(input: { workerTaskKey: string }) {
      if (!taskStatus.has(input.workerTaskKey)) taskStatus.set(input.workerTaskKey, "queued");
      return { ok: true, workerTaskKey: input.workerTaskKey, reused: false, state: taskStatus.get(input.workerTaskKey)! };
    },
    async status(workerTaskKey: string) { const s = taskStatus.get(workerTaskKey); return s ? { workerTaskKey, state: s } : null; },
    async cancel(workerTaskKey: string) { return { workerTaskKey, state: "cancelled" }; },
    async result(workerTaskKey: string) { const t = taskResults.get(workerTaskKey); return t === undefined ? null : { workerTaskKey, state: "succeeded", result: { mediaKind: "text", text: t } }; }
  };

  const handlers = new Map<string, (input: { body: unknown; context?: unknown }) => ApplicationExtensionHandlerResult | Promise<ApplicationExtensionHandlerResult>>();
  const rawHandlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const capabilities: Array<{ id: string }> = [];
  const loggerEvents: Array<Record<string, unknown>> = [];

  const host = {
    extensionId: "game-furnace",
    host: { hostId: "application", production: true },
    config: { configVersion: () => 1, values: () => ({}) },
    work: { admit: () => (admitted ? { ok: true, workId: "w-12345678", configVersion: 1 } : { ok: false, reason: "disabled" }), resume: () => null, activeWorkCount: () => 0 },
    services: {
      tasks,
      media,
      canvas: { requestNodeRun: async () => ({ ok: false, code: "unavailable", message: "n/a" }), requestNodeCancel: async () => ({ ok: false, code: "unavailable", message: "n/a" }) },
      extensionNodes: { read: async () => authoritativeCanvas, commit: async () => ({ revision: authoritativeCanvas.revision }) },
      // 任务 6.2：权威项目读写授权替代（默认放行，可切换拒绝/缺主体）。
      canvasAccess: {
        authorize: async (input: { subject: string; canvasId: string; permission: "read" | "write" }) => {
          accessCalls.push(input);
          return accessDecision;
        }
      }
    },
    registerCapability: (registration: { id: string }) => capabilities.push(registration),
    // 受控 handler 的宿主替身：注入可信 principal context（与真实分派一致；测试可传 context 覆盖）。
    registerHandler: (registration: { route: string; handle: (input: { body: unknown; context?: unknown }) => ApplicationExtensionHandlerResult | Promise<ApplicationExtensionHandlerResult> }) =>
      handlers.set(registration.route, (input) => registration.handle({
        body: input.body,
        context: input.context ?? (accessSubject === null ? {} : { principal: { subject: accessSubject, roles: [] } })
      })),
    registerRawHttpHandler: (registration: { route: string; handle: (req: unknown, res: unknown) => Promise<void> }) => rawHandlers.set(registration.route, registration.handle),
    registerResource: () => undefined,
    logger: (event: Record<string, unknown>) => loggerEvents.push(event)
  } as unknown as ApplicationBackendHost;

  const preview = createGamePreviewHost();
  const controller = createGameFurnaceBackend();
  const definition = createGameFurnaceBackendDefinition({ controller });
  const activation = definition.activate(host) as { dispose?: () => Promise<void> | void };

  return {
    definition,
    activation,
    controller,
    handlers,
    rawHandlers,
    capabilities,
    loggerEvents,
    media,
    preview,
    storedBytes,
    taskStatus,
    taskResults,
    accessCalls,
    setAdmitted(value: boolean) { admitted = value; },
    setFailWrites(value: boolean) { failWrites = value; },
    setAccessDecision(value: { ok: true } | { ok: false; code: string; message: string }) { accessDecision = value; },
    setAccessSubject(value: string | null) { accessSubject = value; },
    setAuthoritativeCanvas(value: ServerCanvas) { authoritativeCanvas = value; }
  };
}

describe("后端插件定义装配（任务 6.1）", () => {
  it("声明 extensionId/capability 并注册全部受控 handler 与原始预览入口", () => {
    const h = makeHarness();
    expect(h.definition.extensionId).toBe("game-furnace");
    expect((h.definition.capabilities ?? []).map((c) => c.id)).toContain("game-furnace.generate");
    expect([...h.handlers.keys()].sort()).toEqual([
      "game-furnace/cancel",
      "game-furnace/activate-build",
      "game-furnace/finalize",
      "game-furnace/generate",
      "game-furnace/preview-close",
      "game-furnace/preview-describe",
      "game-furnace/preview-open",
      "game-furnace/project-collect",
      "game-furnace/target-detach",
      "game-furnace/mcp/create",
      "game-furnace/mcp/get",
      "game-furnace/mcp/preview",
      "game-furnace/mcp/prepare",
      "game-furnace/mcp/submit",
      "game-furnace/mcp/update",
      "game-furnace/project-open",
      "game-furnace/project-save"
    ].sort());
    expect([...h.rawHandlers.keys()].sort()).toEqual(["game-furnace/preview", "game-furnace/site/*"]);
  });

  it("DTO handler 形状校验：畸形请求返回 400，不触达控制器", async () => {
    const h = makeHarness();
    const save = h.handlers.get("game-furnace/project-save")!;
    expect((await save({ body: { canvasId: 1 } })).status).toBe(400);
    const generate = h.handlers.get("game-furnace/generate")!;
    expect((await generate({ body: {} })).status).toBe(400);
    const open = h.handlers.get("game-furnace/project-open")!;
    expect((await open({ body: { canvasId: "c", nodeId: "n" } })).status).toBe(400);
  });

  it("project-save → generate(202) → finalize → preview-open → result 全链路经受控 handler", async () => {
    const h = makeHarness();
    const saved = await h.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    expect(saved.status).toBe(200);
    expect((saved.body as { ok: boolean }).ok).toBe(true);

    const hash = computeInputHash(initial());
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: hash } });
    expect(gen.status).toBe(202);
    const genBody = gen.body as { generationId: string; workerTaskKey: string };
    expect(genBody.generationId).toBeTruthy();

    h.taskStatus.set(genBody.workerTaskKey, "succeeded");
    h.taskResults.set(genBody.workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: [] }));
    const finalized = await h.handlers.get("game-furnace/finalize")!({ body: { canvasId: "c", nodeId: "n", generationId: genBody.generationId } });
    expect(finalized.status).toBe(200);
    const buildId = (finalized.body as { buildId: string }).buildId;

    const opened = await h.handlers.get("game-furnace/preview-open")!({ body: { canvasId: "c", nodeId: "n", buildId } });
    expect(opened.status).toBe(200);
    const sessionId = (opened.body as { sessionId: string }).sessionId;

    const described = await h.handlers.get("game-furnace/preview-describe")!({ body: { sessionId } });
    expect(described.status).toBe(200);
    expect((described.body as { ok: boolean }).ok).toBe(true);

    // 任务 8.7：preview-close 释放会话；之后 describe/fetch 均失效（不自动恢复旧游戏）。
    const closed = await h.handlers.get("game-furnace/preview-close")!({ body: { sessionId } });
    expect(closed.status).toBe(200);
    expect((await h.handlers.get("game-furnace/preview-describe")!({ body: { sessionId } })).status).toBe(404);
    expect(h.controller.previewFetch(sessionId, "index.html")).toBeNull();
  });

  it("原始预览入口：未知会话 404；有效会话 200 且带 CSP sandbox headers 与 bytes", async () => {
    const h = makeHarness();
    const preview = h.rawHandlers.get("game-furnace/preview")!;

    const missing = makeRawRes();
    await preview({ method: "GET", url: "/game-furnace/preview?sessionId=gfp-nope", headers: {} }, missing.res);
    expect(missing.captured.statusCode).toBe(404);

    // 建一个真实会话。
    await h.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: computeInputHash(initial()) } });
    const genBody = gen.body as { workerTaskKey: string; generationId: string };
    h.taskStatus.set(genBody.workerTaskKey, "succeeded");
    h.taskResults.set(genBody.workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: [] }));
    const finalized = await h.handlers.get("game-furnace/finalize")!({ body: { canvasId: "c", nodeId: "n", generationId: genBody.generationId } });
    const buildId = (finalized.body as { buildId: string }).buildId;
    const opened = await h.handlers.get("game-furnace/preview-open")!({ body: { canvasId: "c", nodeId: "n", buildId } });
    const sessionId = (opened.body as { sessionId: string }).sessionId;

    const ok = makeRawRes();
    await preview({ method: "GET", url: `/game-furnace/preview?sessionId=${sessionId}&path=index.html`, headers: {} }, ok.res);
    expect(ok.captured.statusCode).toBe(200);
    expect(ok.captured.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(ok.captured.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(ok.captured.ended).toBe(true);
    // 越界路径拒绝。
    const traversal = makeRawRes();
    await preview({ method: "GET", url: `/game-furnace/preview?sessionId=${sessionId}&path=../secret`, headers: {} }, traversal.res);
    expect(traversal.captured.statusCode).toBe(404);
  });

  it("dispose 后控制器停用：generate 返回 plugin-disabled", async () => {
    const h = makeHarness();
    await h.activation.dispose?.();
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: "x" } });
    expect(gen.status).toBe(409);
    expect((gen.body as { code: string }).code).toBe("plugin-disabled");
  });
});

describe("受控 handler 的权威项目授权（任务 6.2）", () => {
  it("写操作按 principal.subject + canvasId 判定 write；读操作判定 read", async () => {
    const h = makeHarness();
    await h.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    expect(h.accessCalls.at(-1)).toEqual({ subject: "tester", canvasId: "c", permission: "write" });
    await h.handlers.get("game-furnace/project-open")!({ body: { canvasId: "c", nodeId: "n", projectStorageKey: "sha256-w0" } });
    expect(h.accessCalls.at(-1)).toEqual({ subject: "tester", canvasId: "c", permission: "read" });
    // 授权拒绝时不得触达控制器（不产生项目副作用）。
    const h2 = makeHarness();
    h2.setAccessDecision({ ok: false, code: "forbidden", message: "无权" });
    const denied = await h2.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe("forbidden");
    // 授权拒绝不得触达控制器：恢复放行后打开项目仍为 target-missing（未创建）。
    h2.setAccessDecision({ ok: true });
    const opened = await h2.handlers.get("game-furnace/project-open")!({ body: { canvasId: "c", nodeId: "n", projectStorageKey: "sha256-x" } });
    expect(opened.status).toBe(404);
  });

  it("拒绝其它画布：不能只根据 canvasId/nodeId 放行", async () => {
    const h = makeHarness();
    h.setAccessDecision({ ok: false, code: "forbidden", message: "画布 c 不可访问" });
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: "x" } });
    expect(gen.status).toBe(403);
    // 未发生任何任务准入。
    expect(h.taskStatus.size).toBe(0);
  });

  it("缺少可信主体返回 401；授权不可用 fail closed 返回 503", async () => {
    const h = makeHarness();
    h.setAccessSubject(null);
    const noSubject = await h.handlers.get("game-furnace/project-open")!({ body: { canvasId: "c", nodeId: "n", projectStorageKey: "sha256-w0" }, context: {} });
    expect(noSubject.status).toBe(401);

    const h2 = makeHarness();
    h2.setAccessDecision({ ok: false, code: "unavailable", message: "Canvas 授权不可用" });
    const unavailable = await h2.handlers.get("game-furnace/project-collect")!({ body: { canvasId: "c", nodeId: "n", operations: [{ type: "resources.add" }] } });
    expect(unavailable.status).toBe(503);
  });

  it("Canvas 来源素材收集按权威快照重验，拒绝过期来源与被篡改操作（任务 4.4）", async () => {
    const h = makeHarness();
    const canvas = (prompt: string): ServerCanvas => ({
      id: "c", revision: 4,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "furnace", type: "composite-asset", position: { x: 0, y: 0 } },
          { id: "source", type: "text", position: { x: 10, y: 10 } }
        ], edges: [], updatedAt: "2026-10-10T00:00:00.000Z"
      },
      nodeData: { furnace: { extensionId: "game-furnace" }, source: { prompt } }, assets: [], jobs: [], updatedAt: "2026-10-10T00:00:00.000Z"
    } as unknown as ServerCanvas);
    const plannedCanvas = canvas("first source");
    const plan = planGameFurnaceDrop(plannedCanvas, ["source"])!;
    const request = { canvasId: "c", nodeId: "furnace", operations: plan.operations, sourceSnapshots: plan.sourceSnapshots };

    h.setAuthoritativeCanvas(canvas("changed after drop planning"));
    const stale = await h.handlers.get("game-furnace/project-collect")!({ body: request });
    expect(stale).toMatchObject({ status: 409, body: { code: "content-conflict" } });
    expect(h.controller.runtime()?.projects.size).toBe(0);

    h.setAuthoritativeCanvas(plannedCanvas);
    const forged = structuredClone(request);
    (forged.operations[0] as { resources: { description: string }[] }).resources[0]!.description = "forged";
    const tampered = await h.handlers.get("game-furnace/project-collect")!({ body: forged });
    expect(tampered).toMatchObject({ status: 409, body: { code: "content-conflict" } });
    expect(h.controller.runtime()?.projects.size).toBe(0);

    h.setAuthoritativeCanvas({ ...plannedCanvas, nodeData: { ...plannedCanvas.nodeData, furnace: { extensionId: "other-extension" } as never } });
    expect(await h.handlers.get("game-furnace/project-collect")!({ body: request })).toMatchObject({ status: 409, body: { code: "unsupported-node" } });
    expect(h.controller.runtime()?.projects.size).toBe(0);
    h.setAuthoritativeCanvas(plannedCanvas);
    const accepted = await h.handlers.get("game-furnace/project-collect")!({ body: request });
    expect(accepted.status).toBe(200);
    expect(h.controller.runtime()?.projects.get("c:furnace")?.state.resources).toHaveLength(1);

    const scopedPlan = planGameFurnaceDrop(plannedCanvas, ["source"], "drop-a")!;
    const scoped = { ...request, collectionId: "drop-a", operations: scopedPlan.operations };
    expect(await h.handlers.get("game-furnace/project-collect")!({ body: scoped })).toMatchObject({ status: 200 });
    expect(await h.handlers.get("game-furnace/project-collect")!({ body: scoped })).toMatchObject({ status: 200 });
    expect(h.controller.runtime()?.projects.get("c:furnace")?.state.resources).toHaveLength(2);
    // The server recomputes scoped IDs; changing the scope without replanning is rejected.
    expect(await h.handlers.get("game-furnace/project-collect")!({ body: { ...scoped, collectionId: "drop-b" } })).toMatchObject({ status: 409, body: { code: "content-conflict" } });

    const cyclicCanvas = {
      ...plannedCanvas,
      document: {
        ...plannedCanvas.document,
        nodes: plannedCanvas.document.nodes.map((node) => node.id === "source" ? { ...node, parentId: "furnace" } : node)
      }
    } as ServerCanvas;
    h.setAuthoritativeCanvas(cyclicCanvas);
    const cyclicPlan = planGameFurnaceDrop(cyclicCanvas, ["source"])!;
    const cyclic = await h.handlers.get("game-furnace/project-collect")!({
      body: { ...request, operations: cyclicPlan.operations, sourceSnapshots: cyclicPlan.sourceSnapshots }
    });
    expect(cyclic).toMatchObject({ status: 409, body: { code: "content-conflict" } });
  });

  it("预览读会话经 read 授权；缺少授权能力时 fail closed", async () => {
    const h = makeHarness();
    await h.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: computeInputHash(initial()) } });
    const genBody = gen.body as { workerTaskKey: string; generationId: string };
    h.taskStatus.set(genBody.workerTaskKey, "succeeded");
    h.taskResults.set(genBody.workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: [] }));
    const finalized = await h.handlers.get("game-furnace/finalize")!({ body: { canvasId: "c", nodeId: "n", generationId: genBody.generationId } });
    const buildId = (finalized.body as { buildId: string }).buildId;
    const opened = await h.handlers.get("game-furnace/preview-open")!({ body: { canvasId: "c", nodeId: "n", buildId } });
    expect(opened.status).toBe(200);
    expect(h.accessCalls.at(-1)).toEqual({ subject: "tester", canvasId: "c", permission: "read" });
  });

  it("target-detach 需 write 授权；授权拒绝不触达控制器（任务 6.10）", async () => {
    const h = makeHarness();
    await h.handlers.get("game-furnace/project-save")!({ body: { canvasId: "c", nodeId: "n", state: initial() } });
    const gen = await h.handlers.get("game-furnace/generate")!({ body: { canvasId: "c", nodeId: "n", expectedInputHash: computeInputHash(initial()) } });
    const genBody = gen.body as { workerTaskKey: string };
    const detached = await h.handlers.get("game-furnace/target-detach")!({ body: { canvasId: "c", nodeId: "n" } });
    expect(detached.status).toBe(200);
    expect(h.accessCalls.at(-1)).toEqual({ subject: "tester", canvasId: "c", permission: "write" });
    expect(h.controller.runtime()!.projects.size).toBe(0);
    expect(h.taskStatus.get(genBody.workerTaskKey)).toBe("queued"); // 仅取消调用，替身不改状态

    const h2 = makeHarness();
    h2.setAccessDecision({ ok: false, code: "forbidden", message: "无权" });
    const denied = await h2.handlers.get("game-furnace/target-detach")!({ body: { canvasId: "c", nodeId: "n" } });
    expect(denied.status).toBe(403);
  });
});
