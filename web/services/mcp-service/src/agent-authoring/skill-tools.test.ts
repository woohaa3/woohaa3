/**
 * Skill 媒体步骤续接工具测试
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 4.1–4.3）。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { SkillStepClient } from "../downstream/skill-step-client.js";
import type { SkillMediaStepView, SkillStepOutputView, SkillStepWaitView } from "@woohaa3/contracts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function baseClient(): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: true, graph: { protocolVersion: 1, canvasId: "c1", title: "t", revision: 1, nodes: [], edges: [], truncated: false } }; },
    async getChanges() { return { ok: true, delta: { protocolVersion: 1, canvasId: "c1", fromRevision: 1, currentRevision: 1, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } }; },
    async applyPlan(input) { return { ok: true, canvasId: input.canvasId ?? "c1", requestId: input.requestId, revision: 1, duplicate: false, noop: false, nodes: [], edges: [] }; }
  };
}

function step(): SkillMediaStepView {
  return {
    canvasId: "c1",
    nodeId: "img-1",
    skillRunId: "skill-1",
    stepId: "step-1",
    currentAttempt: 2,
    currentRunId: "run-2",
    promptRevision: 2,
    latestSuccessfulRunId: "run-1",
    latestSuccess: { attempt: 1, promptRevision: 1, runId: "run-1" },
    attempts: [
      {
        skillRunId: "skill-1", stepId: "step-1", attempt: 1, promptRevision: 1, runId: "run-1",
        requestId: "req-1", state: "superseded", current: false, superseded: true,
        supersededByAttempt: 2, supersededByRunId: "run-2", prompt: "SECRET OLD PROMPT",
        createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:01:00.000Z"
      },
      {
        skillRunId: "skill-1", stepId: "step-1", attempt: 2, promptRevision: 2, runId: "run-2",
        requestId: "req-2", state: "running", current: true, superseded: false,
        prompt: "SECRET NEW PROMPT", createdAt: "2026-10-28T00:01:00.000Z", updatedAt: "2026-10-28T00:02:00.000Z"
      }
    ],
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:02:00.000Z"
  };
}

function waitView(): SkillStepWaitView {
  return {
    skillRunId: "skill-1",
    stepId: "step-1",
    phase: "succeeded",
    attempt: 2,
    promptRevision: 2,
    runId: "run-2",
    followed: true,
    replacedRunIds: ["run-1"],
    step: step(),
    outputView: {
      available: true,
      current: true,
      skillRunId: "skill-1",
      stepId: "step-1",
      attempt: 2,
      promptRevision: 2,
      runId: "run-2",
      output: {
        kind: "image",
        runId: "run-2",
        url: "/api/media/opaque-2",
        contentType: "image/png",
        size: 32,
        provenance: { canvasId: "c1", nodeId: "img-1", runId: "run-2", jobId: "job-2" }
      }
    }
  };
}

function skillClient(overrides: Partial<SkillStepClient> = {}): SkillStepClient {
  return {
    async wait() { return { ok: true, value: waitView() }; },
    async latestOutput() {
      const view: SkillStepOutputView = {
        available: true,
        current: true,
        skillRunId: "skill-1",
        stepId: "step-1",
        attempt: 2,
        promptRevision: 2,
        runId: "run-2",
        output: { kind: "image", runId: "run-2", url: "/api/media/opaque-2", contentType: "image/png", size: 32, provenance: { canvasId: "c1", nodeId: "img-1", runId: "run-2", jobId: "job-2" } }
      };
      return { ok: true, value: view };
    },
    async snapshot() { return { ok: true, value: step() }; },
    async events() { return { ok: true, value: { events: [], cursor: 0, resetRequired: false } }; },
    ...overrides
  };
}

async function start(options: { skillClient?: SkillStepClient; skillAvailable?: boolean } = {}) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: {
      client: baseClient(),
      runAvailability: { available: true },
      ...(options.skillClient ? { skillClient: options.skillClient } : {}),
      ...(options.skillAvailable !== undefined
        ? { skillAvailability: { available: options.skillAvailable } }
        : {})
    }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(body) as Record<string, unknown>;
}

async function listToolNames(base: string): Promise<string[]> {
  const payload = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return ((payload.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
}

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  const payload = await post(base, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return payload.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
}

describe("Skill 续接工具注册（任务 4.1）", () => {
  it("声明 continuation 能力时注册等待与最新输出工具", async () => {
    const base = await start({ skillClient: skillClient(), skillAvailable: true });
    const names = await listToolNames(base);
    expect(names).toEqual(expect.arrayContaining(["wait_for_skill_step", "get_latest_skill_step_output"]));
  });

  it("未声明 continuation 能力时不注册工具", async () => {
    const base = await start({ skillAvailable: false });
    const names = await listToolNames(base);
    expect(names).not.toContain("wait_for_skill_step");
    expect(names).not.toContain("get_latest_skill_step_output");
  });

  it("能力发现暴露 continuation 工具与上限", async () => {
    const base = await start({ skillClient: skillClient(), skillAvailable: true });
    const result = await callTool(base, "get_canvas_capabilities", { canvasId: "c1" });
    expect(result.structuredContent).toMatchObject({
      continuation: { available: true, tools: ["wait_for_skill_step", "get_latest_skill_step_output"], followLatest: true, maxWaitMs: 30_000 }
    });
  });
});

describe("wait_for_skill_step（任务 4.2）", () => {
  it("返回等待阶段、当前 attempt 与跟随的旧 run，但不泄漏提示词", async () => {
    const calls: unknown[] = [];
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async wait(input) { calls.push(input); return { ok: true, value: waitView() }; }
      })
    });
    const result = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 500, followLatest: true });
    expect(calls[0]).toMatchObject({ canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 500, followLatest: true });
    expect(result.structuredContent).toMatchObject({ ok: true, phase: "succeeded", attempt: 2, followed: true, replacedRunIds: ["run-1"] });
    expect(JSON.stringify(result.structuredContent)).not.toContain("SECRET NEW PROMPT");
    expect(JSON.stringify(result.structuredContent)).not.toContain("SECRET OLD PROMPT");
  });

  it("超时只结束等待并返回有界 phase", async () => {
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async wait() { return { ok: true, value: { ...waitView(), phase: "timeout" as const } }; }
      })
    });
    const result = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 1 });
    expect(result.structuredContent).toMatchObject({ ok: true, phase: "timeout" });
  });

  it("下游错误映射为稳定错误码", async () => {
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async wait() { return { ok: false, code: "forbidden", message: "步骤不属于当前组" }; }
      })
    });
    const result = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("严格 schema（任务 4.1）", () => {
  it("拒绝未知字段与超出上限的等待时间", async () => {
    const base = await start({ skillClient: skillClient(), skillAvailable: true });
    const unknownField = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", nodeId: "img-1", extra: true });
    expect(unknownField.isError).toBe(true);
    const tooLong = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 30_001 });
    expect(tooLong.isError).toBe(true);
  });
});

describe("断线恢复（任务 4.4）", () => {
  it("同一身份再次等待返回权威终态，只重复等待不重发生成", async () => {
    const waits: unknown[] = [];
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async wait(input) { waits.push(input); return { ok: true, value: waitView() }; }
      })
    });
    const first = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 10, followLatest: true });
    const second = await callTool(base, "wait_for_skill_step", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1", waitMs: 10, followLatest: true });
    expect(waits).toHaveLength(2);
    expect(waits[1]).toMatchObject({ skillRunId: "skill-1", stepId: "step-1" });
    // 恢复后仍是同一权威终态与替代关系；客户端没有 run/begin 入口，不会重复已受理生成。
    expect(first.structuredContent).toMatchObject({ phase: "succeeded", attempt: 2, runId: "run-2" });
    expect(second.structuredContent).toEqual(first.structuredContent);
  });

  it("unknown / 无稳定引用不当作成功", async () => {
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async latestOutput() {
          return {
            ok: true,
            value: {
              available: false,
              skillRunId: "skill-1",
              stepId: "step-1",
              attempt: 2,
              promptRevision: 2,
              runId: "run-2",
              reason: "output-unavailable",
              message: "尝试状态待核对，不视为成功",
              fallbackAvailable: false
            }
          };
        }
      })
    });
    const result = await callTool(base, "get_latest_skill_step_output", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1" });
    expect(result.structuredContent).toMatchObject({ available: false, reason: "output-unavailable" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("succeeded");
  });
});

describe("get_latest_skill_step_output（任务 4.3）", () => {
  it("返回稳定同源媒体与 metadata，不含内部 locator", async () => {
    const base = await start({ skillClient: skillClient(), skillAvailable: true });
    const result = await callTool(base, "get_latest_skill_step_output", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1" });
    const content = JSON.stringify(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ ok: true, available: true, current: true, runId: "run-2" });
    expect(content).toContain("/api/media/opaque-2");
    expect(content).not.toMatch(/https?:\/\//);
    expect(content).not.toMatch(/data:|blob:/);
    expect(content).not.toContain("storageKey");
  });

  it("当前尝试失败时明确不可用并报告可回退版本", async () => {
    const base = await start({
      skillAvailable: true,
      skillClient: skillClient({
        async latestOutput() {
          return {
            ok: true,
            value: {
              available: false,
              skillRunId: "skill-1",
              stepId: "step-1",
              attempt: 2,
              promptRevision: 2,
              runId: "run-2",
              reason: "failed",
              message: "当前尝试失败",
              fallbackAvailable: true
            }
          };
        }
      })
    });
    const result = await callTool(base, "get_latest_skill_step_output", { canvasId: "c1", skillRunId: "skill-1", stepId: "step-1" });
    expect(result.structuredContent).toMatchObject({ available: false, reason: "failed", fallbackAvailable: true });
  });
});
