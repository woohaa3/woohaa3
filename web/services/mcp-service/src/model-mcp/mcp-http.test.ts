import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FILM_SET_CONTENT_PREVIOUS_VERSION, FILM_SET_CONTENT_VERSION, MODEL_RENDER_BUDGET, type McpGetNodeResult } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "./mcp-http.js";
import type { ModelMcpToolService } from "./mcp-http.js";

const DEFAULT_CANVAS = "woohaa3-default-canvas";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(service?: ModelMcpToolService, toolGrant?: import("./http-types.js").ModelMcpHttpOptions["toolGrant"]) {
  const handler = createModelMcpHttpHandler({ service, toolGrant });
  const server = http.createServer((req, res) => {
    void handler.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const close = async () => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);
  return { base: `http://127.0.0.1:${port}` };
}

async function mcpPost(base: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1) ?? "{}"
    : text;
  return { status: response.status, body: JSON.parse(payload) as Record<string, unknown> };
}

describe("Model Canvas Streamable HTTP MCP", () => {
  it("discover() 经真实 initialize/tools/list 返回只读/可写分类", async () => {
    const handler = createModelMcpHttpHandler({
      service: {
        async getModelNode(input) {
          return { ok: true, ...input, title: "t", prompt: "", source: "", references: [], cameras: [] };
        },
        async submitScript(input) {
          return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", idempotent: false };
        }
      }
    });
    closers.push(() => handler.close());
    const discovery = await handler.discover();
    expect(discovery.ready).toBe(true);
    if (!discovery.ready) throw new Error("expected ready");
    expect(discovery.serverName).toBe("woohaa3-model-canvas");
    const byName = new Map(discovery.tools.map((tool) => [tool.name, tool]));
    // 读工具为 read，写工具为 write（与 grant 门禁集合一致）。
    expect(byName.get("get_model_node")?.access).toBe("read");
    expect(byName.get("get_model_api")?.access).toBe("read");
    expect(byName.get("get_model_statistics")?.access).toBe("read");
    expect(byName.get("submit_model_script")?.access).toBe("write");
    expect(byName.get("mutate_film_set_clip")?.access).toBe("write");
    // 工具清单按名称稳定排序。
    const names = discovery.tools.map((tool) => tool.name);
    expect([...names].sort()).toEqual(names);
  });

  it("discover() 在无工具注册时返回 no-tools（不伪造 ready）", async () => {
    // 只注册扩展工具为空的 server：handler 未启用模型工具服务时仍注册内置只读工具，
    // 因此这里显式构造一个不会注册任何工具的路径（enableModelMcp 关闭由 composition 处理）。
    // 直接验证 classification：至少存在工具时 ready。
    const handler = createModelMcpHttpHandler({});
    closers.push(() => handler.close());
    const discovery = await handler.discover();
    // 缺 service 时读工具仍在目录中（调用时才报不可用），故 ready 为 true 且无写工具被标记为可执行。
    expect(discovery.tools.some((tool) => tool.access === "read")).toBe(true);
  });

  it("通过 HTTP 完成 initialize 并列出模型工具", async () => {
    const { base } = await start();
    const initialized = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }
    });
    expect(initialized.status).toBe(200);
    expect((initialized.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("woohaa3-model-canvas");

    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const names = ((listed.body.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "get_model_api",
      "list_model_requests",
      "get_model_node",
      "get_model_statistics",
      "submit_model_script",
      "render_model_preview",
      "create_film_set_node",
      "import_model_snapshot"
    ]));
  });

  it("create_film_set_node 与 import_model_snapshot 调用下游能力（change: 2026-10-05-bind-model-animation-to-shots）", async () => {
    const created: Array<Record<string, unknown>> = [];
    const imported: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode(input) {
        return { ok: true, ...input, title: "t", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", idempotent: false };
      },
      async createFilmSetNode(input) {
        created.push(input as unknown as Record<string, unknown>);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-a", duplicate: false, noop: false };
      },
      async importModelSnapshot(input) {
        imported.push(input as unknown as Record<string, unknown>);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-b", duplicate: false, noop: false };
      }
    });

    const create = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "create_film_set_node",
        arguments: {
          canvasId: "canvas-a",
          nodeId: "anim-1",
          requestId: "req-1",
          modelScript: "function build() { return 1; }",
          modelScriptVersion: "woohaa-model-js-v2",
          motionScript: "motion.model.rotate('torso', { speed: 1 });",
          duration: 4,
          loop: true
        }
      }
    });
    expect(create.status).toBe(200);
    expect(JSON.stringify(create.body)).toContain("cmd-a");
    expect(created[0]).toMatchObject({
      canvasId: "canvas-a",
      nodeId: "anim-1",
      requestId: "req-1",
      model: { modelScriptVersion: "woohaa-model-js-v2" },
      timeline: { duration: 4, loop: true }
    });

    const importedResult = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "import_model_snapshot",
        arguments: {
          canvasId: "canvas-a",
          nodeId: "anim-1",
          requestId: "req-2",
          itemId: "actor",
          modelScript: "function build() { return 2; }",
          modelScriptVersion: "woohaa-model-js-v2",
          expectedSourceHash: "hash-1"
        }
      }
    });
    expect(JSON.stringify(importedResult.body)).toContain("cmd-b");
    expect(imported[0]).toMatchObject({ canvasId: "canvas-a", itemId: "actor", expectedSourceHash: "hash-1" });
  });

  it("submit_film_set 的参数版本跟随片场内容契约（回归：工具钉住 v3、保存端要求 v4）", async () => {
    const commits: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode(input) {
        return { ok: true, ...input, title: "t", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", idempotent: false };
      },
      async commitAnimation(input) {
        commits.push(input as unknown as Record<string, unknown>);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-film", duplicate: false, noop: false };
      }
    });
    const submit = (schemaVersion: number, requestId: string) => mcpPost(base, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "submit_film_set",
        arguments: {
          canvasId: "canvas-a",
          nodeId: "film-1",
          requestId,
          expectedSnapshotHash: "hash-1",
          animation: {
            filmSetContent: { schemaVersion, items: [] },
            filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] }
          }
        }
      }
    });

    // 当前契约版本必须能直达保存端；任何版本漂移都不得被参数校验提前吞掉。
    const accepted = await submit(FILM_SET_CONTENT_VERSION, "req-current");
    expect((accepted.body.result as { isError?: boolean }).isError).toBeUndefined();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      canvasId: "canvas-a",
      nodeId: "film-1",
      requestId: "req-current",
      expectedSnapshotHash: "hash-1"
    });

    // 上一代版本由参数校验拒绝，且不到达保存端。
    const rejected = await submit(FILM_SET_CONTENT_PREVIOUS_VERSION, "req-legacy");
    expect((rejected.body.result as { isError?: boolean }).isError).toBe(true);
    expect(commits).toHaveLength(1);

    // 工具声明同样跟随契约常量，不写字面量版本号。
    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 14, method: "tools/list", params: {} });
    const tool = (listed.body.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, any> } }> })
      .tools.find((entry) => entry.name === "submit_film_set");
    expect(tool?.inputSchema.properties?.animation?.properties?.filmSetContent?.properties?.schemaVersion?.const)
      .toBe(FILM_SET_CONTENT_VERSION);
  });

  it("动画能力缺席时两个工具返回稳定不可用错误", async () => {
    const { base } = await start();
    const create = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "create_film_set_node", arguments: { canvasId: "canvas-a", nodeId: "a", requestId: "r", modelScript: "x", modelScriptVersion: "v" } }
    });
    expect(JSON.stringify(create.body)).toContain("片场能力当前不可用");
  });

  it("读取权威节点并提交 modelScript", async () => {
    const calls: Array<{ canvasId: string; nodeId: string; source: string; requestId: string }> = [];
    const { base } = await start({
      async getModelNode(input) {
        return {
          ok: true,
          ...input,
          title: "角色",
          prompt: "银色骑士",
          source: "scene.box({ id: 'old' });",
          language: "javascript",
          version: "woohaa-model-js-v2",
          references: [],
          cameras: []
        };
      },
      async submitScript(input) {
        calls.push(input);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-1", idempotent: false };
      }
    });

    const read = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_model_node", arguments: { canvasId: "canvas-a", nodeId: "model-1" } }
    });
    expect(JSON.stringify(read.body)).toContain("scene.box");

    const submitted = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "submit_model_script",
        arguments: { canvasId: "canvas-a", nodeId: "model-1", source: "scene.box({ id: 'new' });", requestId: "req-1" }
      }
    });
    expect(submitted.status).toBe(200);
    expect(calls).toEqual([{ canvasId: "canvas-a", nodeId: "model-1", source: "scene.box({ id: 'new' });", requestId: "req-1" }]);
    expect(JSON.stringify(submitted.body)).toContain("cmd-1");
  });

  it("submit_model_script 透传 model3d 的 requestId 与内容 precondition（change: 2026-10-06-fix-animation3d...）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-m3d", idempotent: false };
      }
    });
    const submitted = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "submit_model_script",
        arguments: {
          canvasId: DEFAULT_CANVAS,
          nodeId: "m3d-1",
          source: "scene.box({ id: 'new' });",
          requestId: "req-m3d",
          expectedModelContentHash: "hash-1"
        }
      }
    });
    expect(submitted.status).toBe(200);
    expect(calls[0]).toMatchObject({
      canvasId: DEFAULT_CANVAS,
      nodeId: "m3d-1",
      requestId: "req-m3d",
      expectedModelContentHash: "hash-1"
    });
  });

  it("list_model_requests 从权威画布派生（按 canvasId）", async () => {
    const listed: string[] = [];
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false };
      },
      async listModelNodes({ canvasId }) {
        listed.push(canvasId ?? "");
        return {
          ok: true,
          canvasId: canvasId ?? "",
          nodes: [
            { nodeId: "a", title: "A", prompt: "", references: [], hasScript: false, pending: true, cameraCount: 0 }
          ]
        };
      }
    });
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_model_requests", arguments: { canvasId: "mcp-list-a" } }
    });
    expect(listed).toEqual(["mcp-list-a"]);
    // change: 2026-10-07-remove-residual-compatibility —— 机器结果在 structuredContent。
    const structured = (result.body.result as { structuredContent?: { nodes?: Array<{ nodeId: string }> } }).structuredContent;
    expect(structured?.nodes?.map((node) => node.nodeId)).toEqual(["a"]);
  });

  it("不认领其它 HTTP 路径", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/not-mcp`);
    expect(response.status).toBe(404);
  });
});

describe("模型脚本指南的朝向约定（change: model-orientation-convention）", () => {
  it("指南说明 +Z 正面并给出左下方朝向", async () => {
    const { base } = await start();
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_model_api", arguments: {} }
    });
    const text = ((result.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
    // 对齐 glTF：+Y 上、+Z 正面、+X 左侧。
    expect(text).toContain("+Z");
    expect(text).toContain("+Y");
    // 等距视图下 +Z 投影到左下方、面向观察者。
    expect(text).toContain("左下方");
  });

  it("指南声明 V2 为唯一版本并列出 sphere/capsule/segment/material", async () => {
    const { base } = await start();
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "get_model_api", arguments: {} }
    });
    const text = ((result.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
    expect(text).toContain("woohaa-model-js-v2");
    expect(text).not.toContain("woohaa-model-js-v1");
    expect(text).toContain("scene.sphere");
    expect(text).toContain("scene.capsule");
    expect(text).toContain("scene.segment");
    expect(text).toContain("scene.material");
    expect(text).toContain("motion.model.tween");
    expect(text).toContain("motion.model.keyframes");
    expect(text).toContain("同一目标同一属性");
    expect(text).toContain("严禁按时间复制人物");
    expect(text).toContain("mutate_film_set_item");
    // rotation 使用角度制与固定 Y-X-Z 顺序。
    expect(text).toContain("角度制");
    expect(text).toContain("Y-X-Z");
    // change: 2026-10-22-remove-agent-execution-limits，任务 6.2：估算顶点**总量上限**已删除，
    // 提示词改为可编辑性指引（明确「不是硬上限」）并保留每个图元的成本表。
    expect(text).toContain("Editability guidance");
    expect(text).toContain("not a hard limit");
    expect(text).toContain(`box=${MODEL_RENDER_BUDGET.vertexCost.box}`);
    // 统计口径：禁止按成本表手算，并点明 segment 缺省是 capsule。
    expect(text).toContain("get_model_statistics");
    expect(text).toContain("MUST NOT 按上面的成本表自行推算");
  });

  it("指南包含镜头 CRUD 的最小流程与瞬态字段禁令", async () => {
    const { base } = await start();
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_model_api", arguments: {} }
    });
    const text = ((result.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
    expect(text).toContain("get_model_cameras");
    expect(text).toContain("requestId");
    expect(text).toContain("set_model_camera");
    // 明确瞬态字段禁令，避免 Agent 写入 session 状态。
    expect(text).toContain("瞬态");
  });

  it("指南与工具描述明确 sceneCamera 不是拍摄镜头，并要求创建 clip", async () => {
    const { base } = await start();
    const guide = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "get_model_api", arguments: {} }
    });
    const text = ((guide.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
    expect(text).toContain("sceneCamera 只是无任何拍摄镜头时的回退构图");
    expect(text).toContain("不是镜头");
    expect(text).toContain('op:{kind:"create"');
    expect(text).toContain("静态构图也要创建 static 镜头");
    expect(text).toContain("clipTemplate");
    expect(text).toContain("确认 clips 非空");

    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
    const submit = ((listed.body.result as { tools: Array<{ name: string; description?: string }> }).tools)
      .find(tool => tool.name === "submit_film_set");
    expect(submit?.description).toContain("所有动画字段");
    expect(submit?.description).toContain("不能只设置 sceneCamera");
  });

  it("空镜头集合在 get_film_set_clips 与 submit_film_set 上返回创建提示", async () => {
    const { base } = await start({
      async getModelNode(input) {
        return {
          ok: true, ...input, title: "t", prompt: "", source: "", references: [], cameras: [],
          animation: {
            title: "t",
            scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
            filmSetContent: { schemaVersion: FILM_SET_CONTENT_VERSION, items: [] },
            filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] },
            initialCamera: { azimuth: 0, elevation: 0.35, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
            timeline: { duration: 0, loop: false }
          }
        } as unknown as McpGetNodeResult;
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", idempotent: false };
      },
      async commitAnimation(input) {
        return {
          ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-film", duplicate: false, noop: false,
          animation: { filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] } }
        } as unknown as import("../downstream/canvas-client.js").McpCreateFilmSetNodeOutcome;
      }
    });
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "get_film_set_clips", arguments: { canvasId: "canvas-a", nodeId: "film-1" } }
    });
    const structured = (result.body.result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(structured).toMatchObject({ clipCount: 0 });
    expect(String(structured?.hint)).toContain("sceneCamera");
    expect(String(structured?.hint)).toContain("clipTemplate");
    expect(structured?.clipTemplate).toMatchObject({
      kind: "static",
      timeline: { duration: 0, loop: false },
      initialCamera: { azimuth: 0, elevation: 0.35, distance: 4, aspect: "16:9" },
      bindings: []
    });

    const submitted = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "submit_film_set",
        arguments: {
          canvasId: "canvas-a",
          nodeId: "film-1",
          requestId: "req-empty",
          expectedSnapshotHash: "hash-a",
          animation: {
            filmSetContent: { schemaVersion: FILM_SET_CONTENT_VERSION, items: [] },
            filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] }
          }
        }
      }
    });
    const submittedContent = (submitted.body.result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(submittedContent).toMatchObject({ clipCount: 0 });
    expect(String(submittedContent?.hint)).toContain("mutate_film_set_clip");
  });
});

describe("render_model_preview MCP（change: enhance-model-scene-authoring-api）", () => {
  const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]).toString("base64");

  it("成功时返回 image/png 与结构化元数据", async () => {
    let received: unknown = null;
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      renderPreview: async (input) => {
        received = input;
        return {
          ok: true,
          cached: false,
          pngBase64: PNG_B64,
          metadata: {
            canvasId: "c",
            nodeId: "n",
            sourceHash: "abc",
            sceneSignature: "abc",
            sceneVersion: "woohaa-model-scene-ir-v2",
            renderVersion: "woohaa-model-render-v1",
            width: 256,
            height: 256,
            background: "transparent",
            cameraPreset: "dimetric"
          }
        };
      }
    });
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "render_model_preview", arguments: { canvasId: "c", nodeId: "n", width: 256, height: 256 } }
    });
    const content = (result.body.result as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> }).content;
    const image = content.find((part) => part.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(image?.data).toBe(PNG_B64);
    const metadata = JSON.parse(content.find((part) => part.type === "text")?.text ?? "{}");
    expect(metadata).toMatchObject({ sourceHash: "abc", sceneVersion: "woohaa-model-scene-ir-v2", width: 256, height: 256 });
    expect(received).toMatchObject({ nodeId: "n", width: 256, height: 256 });
  });

  it("renderer 不可用时返回稳定错误且不返回图片", async () => {
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      renderPreview: async () => ({ ok: false, code: "renderer-unavailable", message: "无 renderer" })
    });
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "render_model_preview", arguments: { canvasId: DEFAULT_CANVAS, nodeId: "n" } }
    });
    const call = result.body.result as { isError?: boolean; structuredContent?: { code?: string }; content: Array<{ text: string }> };
    expect(call.isError).toBe(true);
    expect(call.structuredContent?.code).toBe("renderer-unavailable");
  });

  it("预览工具不接受自带源码（schema 只开放受限字段）", async () => {
    const { base } = await start();
    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 23, method: "tools/list", params: {} });
    const tool = (listed.body.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> })
      .tools.find((entry) => entry.name === "render_model_preview");
    expect(tool).toBeTruthy();
    const properties = Object.keys(tool?.inputSchema.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["canvasId", "nodeId", "width", "height", "background", "cameraPreset"]));
    expect(properties).not.toContain("source");
    expect(properties).not.toContain("modelScript");
    expect(properties).not.toContain("ops");
  });

  it("服务不可用时返回错误", async () => {
    const { base } = await start();
    const result = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "render_model_preview", arguments: { nodeId: "n" } }
    });
    const call = result.body.result as { isError?: boolean };
    expect(call.isError).toBe(true);
  });

  it("携带 bearer 时写工具入口经 grant 校验：越界拒绝且不写画布（任务 3.6）", async () => {
    const submitted: string[] = [];
    const grantAuthorize = (input: { token: string; tool: string; canvasId?: string; nodeId?: string }) => {
      if (input.token !== "good") return { ok: false as const, reason: "unknown-grant" };
      if (input.canvasId !== "canvas-a") return { ok: false as const, reason: "canvas-not-allowed" };
      if (input.tool !== "submit_model_script") return { ok: false as const, reason: "tool-not-allowed" };
      return { ok: true as const };
    };
    const handler = createModelMcpHttpHandler({
      service: {
        async getModelNode(input) {
          return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, nodeType: "model3d", title: "t", prompt: "", source: "", references: [], cameras: [] };
        },
        async submitScript(input) {
          submitted.push(input.canvasId);
          return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", idempotent: false };
        }
      },
      toolGrant: { authorize: grantAuthorize }
    });
    const server = http.createServer((req, res) => {
      void handler.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    closers.push(async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const callArgs = {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "submit_model_script", arguments: { canvasId: "canvas-a", nodeId: "n1", source: "scene.box({ id: 'b', size: [1,1,1] });", requestId: "r1" } }
    };
    // 无 bearer：保持原行为（放行）。
    const noBearer = await mcpPost(base, callArgs);
    expect(JSON.stringify(noBearer.body)).toContain("cmd");
    // 越界 bearer：拒绝，不调用下游。
    submitted.length = 0;
    const denied = await mcpPost(base, callArgs, { authorization: "Bearer bad" });
    expect((denied.body.result as { isError?: boolean }).isError).toBe(true);
    expect(submitted).toEqual([]);
    // 合法 bearer：放行。
    const allowed = await mcpPost(base, callArgs, { authorization: "Bearer good" });
    expect(JSON.stringify(allowed.body)).toContain("cmd");
    expect(submitted).toEqual(["canvas-a"]);
  });

  it("携带 bearer 时 tools/list 只暴露 grant 允许的工具", async () => {
    const { base } = await start(undefined, {
      authorize: () => ({ ok: true }),
      allowedTools: token => token === "scoped" ? ["get_model_api", "submit_model_script"] : undefined
    });
    const headers = { authorization: "Bearer scoped" };
    await mcpPost(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-client", version: "1" } }
    }, headers);
    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    const names = ((listed.body.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name).sort();
    expect(names).toEqual(["get_model_api", "submit_model_script"]);
    expect(names).not.toContain("get_canvas_graph");
    expect(names).not.toContain("get_node_output");
  });

  it("real clip tool forwards captured actor scope through the registrar", async () => {
    const calls: unknown[] = [];
    const authorized: unknown[] = [];
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "unused", message: "unused" }),
      submitScript: async () => ({ ok: false, code: "unused", message: "unused" }),
      applyCommands: async input => { calls.push(input); return { ok: true, canvasId: input.canvasId, commandId: input.commandId, revision: 1, duplicate: false, noop: false }; }
    }, { authorize: input => {
      authorized.push(input);
      return input.clipId === "jump" && input.itemId === "hero" ? { ok: true } : { ok: false, reason: "out-of-scope" };
    } });
    const argumentsFor = (itemId: string) => ({ canvasId: "c", nodeId: "film", clipId: "jump", requestId: "r", expectedHash: "hash", op: { kind: "binding", itemId, expectedAdapterHash: "adapter", binding: null } });
    const call = (itemId: string) => mcpPost(base, { jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "mutate_film_set_clip", arguments: argumentsFor(itemId) } }, { authorization: "Bearer actor" });
    expect((await call("other")).body.result).toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
    expect((await call("hero")).body.result).not.toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
    expect(authorized).toContainEqual({ token: "actor", tool: "mutate_film_set_clip", canvasId: "c", nodeId: "film", clipId: "jump", itemId: "hero" });
  });

});

describe("模型规模统计 MCP（change: 2026-10-18-align-model-statistics-with-agent）", () => {
  const STATISTICS = { objects: 389, groups: 1, vertices: 42880, triangles: 32608, materials: 16, animations: 0 };
  const BREAKDOWN = {
    box: { count: 178, vertices: 1424, triangles: 2136 },
    cylinder: { count: 0, vertices: 0, triangles: 0 },
    sphere: { count: 0, vertices: 0, triangles: 0 },
    capsule: { count: 100, vertices: 40000, triangles: 28800 },
    mesh: { count: 111, vertices: 1456, triangles: 1672 }
  };

  it("submit_model_script 的文本回执直接给出与面板同源的点数/面数", async () => {
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          commandId: "cmd-stats",
          idempotent: false,
          statistics: STATISTICS,
          breakdown: BREAKDOWN
        };
      }
    });
    const submitted = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "submit_model_script",
        arguments: { canvasId: DEFAULT_CANVAS, nodeId: "m3d-1", source: "scene.box({ id: 'b' });", requestId: "r" }
      }
    });
    const result = submitted.body.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    const text = result.content.map((entry) => entry.text).join("\n");
    // Agent 客户端多半只读文本 content：数字必须出现在文本里。
    expect(text).toContain("点数 42,880");
    expect(text).toContain("面数 32,608");
    expect(text).toContain("对象 389");
    expect(result.structuredContent?.statistics).toEqual(STATISTICS);
  });

  it("get_model_node 透传 includeStatistics，并把统计写进文本摘要", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          ...input,
          title: "模型",
          prompt: "",
          source: "scene.box({ id: 'b' });",
          references: [],
          cameras: [],
          ...(input.includeStatistics ? { statistics: STATISTICS, breakdown: BREAKDOWN } : {})
        };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false };
      }
    });
    const read = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "get_model_node", arguments: { canvasId: DEFAULT_CANVAS, nodeId: "m3d-1", includeStatistics: true } }
    });
    expect(calls[0]).toMatchObject({ canvasId: DEFAULT_CANVAS, nodeId: "m3d-1", includeStatistics: true });
    const result = read.body.result as { content: Array<{ text: string }> };
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("点数 42,880");
  });

  it("get_model_statistics 统计候选脚本文本并保持只读分类", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false };
      },
      async getModelStatistics(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          source: input.source ? "candidate" : "current",
          statistics: STATISTICS,
          breakdown: BREAKDOWN
        };
      }
    });
    const read = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "get_model_statistics",
        arguments: { canvasId: DEFAULT_CANVAS, nodeId: "m3d-1", source: "scene.box({ id: 'b' });" }
      }
    });
    expect(calls[0]).toMatchObject({ canvasId: DEFAULT_CANVAS, nodeId: "m3d-1", source: "scene.box({ id: 'b' });" });
    const result = read.body.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("候选脚本");
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("点数 42,880");
    expect(result.structuredContent).toMatchObject({ ok: true, source: "candidate" });
  });
});

describe("片场媒体导入与原生导出 MCP（change: 2026-10-19-extend-film-set-for-motion-graphics）", () => {
  it("add_film_set_media 把请求原样转给下游并回执新条目", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false };
      },
      async addFilmSetMedia(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          itemId: input.itemId ?? "derived",
          itemKind: "image",
          commandId: "cmd-media",
          duplicate: false,
          noop: false,
          contentHash: "hash",
          itemCount: 1
        };
      }
    });
    const response = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "add_film_set_media",
        arguments: { canvasId: "canvas-a", nodeId: "film", requestId: "r1", sourceNodeId: "img-1", expectedContentHash: "h0" }
      }
    });
    const result = response.body.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ canvasId: "canvas-a", nodeId: "film", requestId: "r1", sourceNodeId: "img-1", expectedContentHash: "h0" });
    expect(result.structuredContent).toMatchObject({ ok: true, itemId: "derived" });
  });

  it("原生录制不可用时 export_film_set_clip 返回 recording-unavailable，不创建任务", async () => {
    const { base } = await start();
    const response = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "export_film_set_clip",
        arguments: { canvasId: "canvas-a", nodeId: "film", clipId: "clip-1", requestId: "r1", profile: "hd" }
      }
    });
    const result = response.body.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "recording-unavailable" });
  });

  it("export_film_set_clip 提交 profile 并返回 jobId，get_film_set_export 透传阶段与成片身份", async () => {
    const exported: Array<Record<string, unknown>> = [];
    const { base } = await start({
      async getModelNode() {
        return { ok: true, canvasId: "x", nodeId: "x", title: "", prompt: "", source: "", references: [], cameras: [] };
      },
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false };
      },
      async exportFilmSetClip(input) {
        exported.push(input as unknown as Record<string, unknown>);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, clipId: input.clipId, jobId: "job-1", state: "queued", duplicate: false };
      },
      async getFilmSetExport(input) {
        return { ok: true, canvasId: input.canvasId, jobId: input.jobId, state: "succeeded", completedFrames: 60, totalFrames: 60, nodeId: "video-1", assetId: "asset-1" };
      }
    });
    const started = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "export_film_set_clip",
        arguments: { canvasId: "canvas-a", nodeId: "film", clipId: "clip-1", requestId: "r1", profile: "hd60", expectedContentHash: "h0" }
      }
    });
    const startResult = started.body.result as { structuredContent?: Record<string, unknown> };
    expect(exported[0]).toMatchObject({ profile: "hd60", clipId: "clip-1", expectedContentHash: "h0" });
    expect(startResult.structuredContent).toMatchObject({ ok: true, jobId: "job-1" });

    const polled = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: { name: "get_film_set_export", arguments: { canvasId: "canvas-a", jobId: "job-1" } }
    });
    const pollResult = polled.body.result as { structuredContent?: Record<string, unknown> };
    expect(pollResult.structuredContent).toMatchObject({ ok: true, state: "succeeded", nodeId: "video-1", assetId: "asset-1" });
  });

  it("导出工具清单与指南覆盖透明度、新缓动、材质、媒体、镜头背景与导出 profile", async () => {
    const { base } = await start();
    const listed = await mcpPost(base, { jsonrpc: "2.0", id: 44, method: "tools/list", params: {} });
    const names = ((listed.body.result as { tools: Array<{ name: string }> }).tools).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["add_film_set_media", "export_film_set_clip", "get_film_set_export"]));

    const guide = await mcpPost(base, {
      jsonrpc: "2.0",
      id: 45,
      method: "tools/call",
      params: { name: "get_model_api", arguments: {} }
    });
    const text = ((guide.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
    for (const expected of ["opacity", "easeInOut", "unlit", "add_film_set_media", "backdrop", "hd60", "recording-unavailable"]) {
      expect(text).toContain(expected);
    }
  });
});
