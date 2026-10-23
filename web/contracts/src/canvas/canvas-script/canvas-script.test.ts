/**
 * Canvas Script 协议与共享纯编译器测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1–1.4）。
 *
 * 覆盖：严格 codec（未知版本/未知字段/空身份/非法 expectedRevision/源码字节预算）、
 * API 指南事实源、脚本渲染器示例生成预期语义、已规划节点几何投影、principal 身份派生与冲突。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_SCRIPT_API_SIGNATURES,
  CANVAS_SCRIPT_GUIDE_EXAMPLE,
  CANVAS_SCRIPT_GUIDE_TEXT,
  canvasScriptApiDescriptor,
  canvasScriptSourceBytes,
  compileAgentPlanWithHash,
  decodeCanvasScriptRequest,
  type PlanCompileInput,
  type PlannerSnapshot
} from "./index.js";
import type { AgentPlanOperation } from "../agent-canvas-protocol.js";

function snapshot(overrides: Partial<PlannerSnapshot> = {}): PlannerSnapshot {
  return {
    canvasId: "c1",
    revision: 3,
    nodes: [
      { id: "text-1", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
      { id: "img-1", type: "image", position: { x: 300, y: 0 }, width: 248, height: 232 }
    ],
    edges: [],
    ...overrides
  };
}

async function compile(
  operations: AgentPlanOperation[],
  overrides: Partial<PlanCompileInput> = {}
): Promise<ReturnType<typeof compileAgentPlanWithHash>> {
  return compileAgentPlanWithHash({
    canvasId: "c1",
    requestId: "req-1",
    scope: "submit_canvas_script",
    principalId: "principal-a",
    operations,
    snapshot: snapshot(),
    ...overrides
  });
}

describe("严格 codec（任务 1.1）", () => {
  it("接受合法请求并保留可选字段", () => {
    const decoded = decodeCanvasScriptRequest(
      { canvasId: "c1", requestId: "r1", version: "woohaa-canvas-js-v1", source: "1+1", expectedRevision: 2 }
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({ canvasId: "c1", requestId: "r1", version: "woohaa-canvas-js-v1", source: "1+1", expectedRevision: 2 });
  });

  it("拒绝未知版本、未知字段、空身份与非法 expectedRevision", () => {
    const base = { canvasId: "c1", requestId: "r1", version: "woohaa-canvas-js-v1", source: "1+1" };
    expect(decodeCanvasScriptRequest({ ...base, version: "v9" })).toMatchObject({ ok: false, error: { code: "unsupported-version" } });
    expect(decodeCanvasScriptRequest({ ...base, extra: 1 })).toMatchObject({ ok: false, error: { code: "malformed-request", field: "extra" } });
    expect(decodeCanvasScriptRequest({ ...base, canvasId: "" })).toMatchObject({ ok: false, error: { code: "malformed-request" } });
    expect(decodeCanvasScriptRequest({ ...base, requestId: "" })).toMatchObject({ ok: false, error: { code: "malformed-request" } });
    expect(decodeCanvasScriptRequest({ ...base, source: "" })).toMatchObject({ ok: false, error: { code: "malformed-request" } });
    expect(decodeCanvasScriptRequest({ ...base, expectedRevision: -1 })).toMatchObject({ ok: false, error: { code: "malformed-request", field: "expectedRevision" } });
    expect(decodeCanvasScriptRequest({ ...base, expectedRevision: 1.5 })).toMatchObject({ ok: false, error: { code: "malformed-request" } });
  });

  it("不再接受任何提交凭证字段：validationToken 按未知字段拒绝", () => {
    const base = { canvasId: "c1", requestId: "r1", version: "woohaa-canvas-js-v1", source: "1+1", validationToken: "tok" };
    expect(decodeCanvasScriptRequest(base)).toMatchObject({ ok: false, error: { code: "malformed-request", field: "validationToken" } });
  });

  it("不再按源码 UTF-8 字节数拒绝大脚本（任务 5.1）", () => {
    // change: 2026-10-22-remove-agent-execution-limits：原 128 KiB 源码门禁已删除。
    const big = "好".repeat(200_000);
    expect(canvasScriptSourceBytes(big)).toBeGreaterThan(128 * 1024);
    expect(decodeCanvasScriptRequest(
      { canvasId: "c1", requestId: "r1", version: "woohaa-canvas-js-v1", source: big }
    )).toMatchObject({ ok: true });
  });
});

describe("API 指南（任务 1.2）", () => {
  it("公开节点和分类 API 签名与执行边界，且不把 prompt 描述为作品输出", () => {
    const descriptor = canvasScriptApiDescriptor();
    expect(descriptor.apis.map((entry) => entry.name)).toEqual(["node", "group", "reparent", "ungroup", "setTitle", "layout", "existing", "connect", "move", "setPrompt", "remove"]);
    // change: 2026-10-22-remove-agent-execution-limits，任务 6.1：声明隔离/可取消，不声明应用额度。
    expect(descriptor.execution).toMatchObject({ isolated: true, cancellable: true, applicationQuotas: [] });
    expect(descriptor.execution).not.toHaveProperty("limits");
    expect(descriptor.version).toBe("woohaa-canvas-js-v1");
    expect(CANVAS_SCRIPT_API_SIGNATURES.every((entry) => entry.signature.length > 0)).toBe(true);
    // 指南明确 prompt 是生成输入，不是作品输出。
    expect(CANVAS_SCRIPT_GUIDE_TEXT).toContain("生成输入");
    expect(CANVAS_SCRIPT_GUIDE_TEXT).toContain("不冒充已有文本作品输出");
  });

  it("指南示例使用 node/connect 且能表达循环建图", () => {
    expect(CANVAS_SCRIPT_GUIDE_EXAMPLE).toContain("canvas.node(\"text\"");
    expect(CANVAS_SCRIPT_GUIDE_EXAMPLE).toContain("canvas.node(\"image\"");
    expect(CANVAS_SCRIPT_GUIDE_EXAMPLE).toContain("canvas.connect(brief, shot");
    expect(CANVAS_SCRIPT_GUIDE_EXAMPLE).toContain("for (let i = 0; i < 3; i++)");
  });

  it("指南显式说明 key 只是 plan-local ref，不是跨次 upsert", () => {
    expect(CANVAS_SCRIPT_GUIDE_TEXT).toContain("不是跨次 upsert");
  });
});

describe("共享编译器：已规划节点几何投影（任务 1.3）", () => {
  it("after placement 可指向本次计划内新建节点", async () => {
    const result = await compile([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: 2000, y: 0 } } },
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "after", anchor: { ref: "t" } } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const image = result.commands[1] as { node: { position: { x: number; y: number } } };
    // text 宽 248 + gap 40 = 2288。
    expect(image.node.position.x).toBeGreaterThanOrEqual(2000 + 248);
    expect(result.predicted["t"]).toEqual({ x: 2000, y: 0 });
    expect(result.predicted["i"]).toBeDefined();
  });

  it("move 后相对布局使用移动后的最新位置", async () => {
    const result = await compile([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: 5000, y: 0 } } },
      { op: "move_node", target: { ref: "t" }, position: { x: 10000, y: 7000 } },
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "below", anchor: { ref: "t" } } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const image = result.commands[2] as { node: { position: { y: number } } };
    expect(image.node.position.y).toBeGreaterThanOrEqual(7000 + 232);
    expect(result.predicted["t"]).toEqual({ x: 10000, y: 7000 });
  });

  it("前向锚点拒绝；已删除锚点拒绝", async () => {
    const forward = await compile([
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "after", anchor: { ref: "later" } } },
      { op: "create_node", ref: "later", kind: "text" }
    ]);
    expect(forward.ok).toBe(false);
    if (!forward.ok) expect(forward.error.code).toBe("unknown-ref");

    const deleted = await compile([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: 2000, y: 0 } } },
      { op: "delete", targets: [{ ref: "t" }] },
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "after", anchor: { ref: "t" } } }
    ]);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("unknown-ref");
  });

  it("已删除 ref 不能继续被操作", async () => {
    const result = await compile([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: 2000, y: 0 } } },
      { op: "delete", targets: [{ ref: "t" }] },
      { op: "set_prompt", target: { ref: "t" }, prompt: "x" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown-ref");
  });

  it("既有 JSON 路径（无 principal）保持旧实体身份前缀", async () => {
    const result = await compile(
      [{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }],
      { principalId: undefined, scope: "apply_canvas_plan", requestId: "req-1" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refs["n0"]).toMatch(/^image-/);
    // 既有路径 commandId 前缀不变。
    expect(result.commandId).toMatch(/^agent-plan:/);
  });
});

describe("principal 身份派生与冲突（任务 1.4）", () => {
  it("相同 principal/canvas/requestId/ref 得到稳定实体 ID", async () => {
    const operations: AgentPlanOperation[] = [{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }];
    const first = await compile(operations);
    const second = await compile(operations);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.refs["n0"]).toBe(second.refs["n0"]);
  });

  it("不同 principal 得到不同实体 ID（跨主体身份隔离）", async () => {
    const operations: AgentPlanOperation[] = [{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }];
    const a = await compile(operations, { principalId: "principal-a" });
    const b = await compile(operations, { principalId: "principal-b" });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.refs["n0"]).not.toBe(b.refs["n0"]);
  });

  it("重复 key（显式与自动 key 冲突）拒绝", async () => {
    const duplicate = await compile([
      { op: "create_node", ref: "n", kind: "text", placement: { mode: "absolute", position: { x: 3000, y: 0 } } },
      { op: "create_node", ref: "n", kind: "image", placement: { mode: "absolute", position: { x: 3400, y: 0 } } }
    ]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate-ref");

    // 节点 key 与边 key 共享命名空间。
    const shared = await compile([
      { op: "create_node", ref: "k", kind: "text", placement: { mode: "absolute", position: { x: 3000, y: 0 } } },
      { op: "connect", ref: "k", from: { nodeId: "text-1" }, to: { nodeId: "img-1" } }
    ]);
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.error.code).toBe("duplicate-ref");
  });

  it("预测位置与 touchedExistingNodeIds 用于授权范围复核", async () => {
    const result = await compile([
      { op: "set_prompt", target: { nodeId: "img-1" }, prompt: "x" },
      { op: "move_node", target: { nodeId: "text-1" }, position: { x: 10, y: 10 } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touchedExistingNodeIds.sort()).toEqual(["img-1", "text-1"]);
    expect(result.predicted["text-1"]).toEqual({ x: 10, y: 10 });
  });
});
