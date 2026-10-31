import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentConversationApiHandler } from "./agent-conversation-api.js";
import type { AgentConversationService } from "../extensions/agent-conversation-service.js";
import { SqliteSkillMediaStore } from "../skill-media/store.js";
import { createSkillMediaService, type SkillMediaCanvasPort } from "../skill-media/index.js";

const servers: http.Server[] = [];
const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  // 先关 SQLite 再删目录：Windows 上句柄没关会 EBUSY，删目录就报 EPERM。
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function serviceStub(): AgentConversationService {
  const notImplemented = () => { throw new Error("not-implemented"); };
  return {
    createConversation: notImplemented, listConversations: notImplemented, listGroupExecutions: notImplemented,
    readConversation: notImplemented, acceptTurn: notImplemented, dispatchTurn: notImplemented, whenSettled: notImplemented,
    queryTurn: notImplemented, cancelTurn: notImplemented, linkRun: notImplemented, locateTurnByRun: notImplemented,
    catalog: notImplemented, reconcileUnknown: notImplemented, deleteAll: notImplemented
  } as unknown as AgentConversationService;
}

async function boot(options: {
  subject?: string;
  access?: boolean;
  canvas?: SkillMediaCanvasPort;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "woohaa-skill-api-"));
  dirs.push(dir);
  const store = new SqliteSkillMediaStore({ path: join(dir, "application.sqlite") });
  stores.push(store);
  const canvas: SkillMediaCanvasPort = options.canvas ?? {
    async run(input) { return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, jobId: "job", state: "accepted" }; },
    async cancel(input) { return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, state: "cancel-requested" }; },
    async status(input) { return { ok: true, view: { protocolVersion: 1, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, jobId: "job", phase: "running", stale: false } }; },
    async output() { return { ok: false, code: "unavailable", message: "no output" }; }
  };
  const skillMedia = createSkillMediaService({
    store,
    canvas,
    deriveRunId: ({ requestId }) => `run-${requestId}`,
    now: () => "2026-10-28T00:00:00.000Z"
  });
  await skillMedia.begin({ owner: "user-a", canvasId: "canvas", skillRunId: "skill", stepId: "step", nodeId: "node", requestId: "req-1", runId: "run-1", prompt: "一只猫" });
  const handler = createAgentConversationApiHandler({
    service: serviceStub(),
    skillMedia,
    canvasAccess: { authorize: async () => options.access === false ? { ok: false as const, code: "forbidden", message: "no" } : { ok: true as const } },
    authenticator: async () => ({ subject: options.subject ?? "user-a", sessionId: "s1", identityProvider: "test" })
  });
  const server = http.createServer((req, res) => { void handler(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, store, skillMedia };
}

describe("Skill 媒体步骤 HTTP API", () => {
  it("按节点读取当前尝试", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/by-node?canvasId=canvas&nodeId=node`);
    const body = await response.json() as { ok: boolean; step: { currentAttempt: number } };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, step: { currentAttempt: 1 } });
  });

  it("重新生成派生新 run 并返回新步骤快照", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/skill/step/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "canvas", requestId: "req-2", prompt: "一只橘猫" })
    });
    const body = await response.json() as { ok: boolean; runId: string; step: { currentAttempt: number; attempts: Array<{ state: string }> } };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, runId: "run-req-2", step: { currentAttempt: 2 } });
    expect(body.step.attempts.map((entry) => entry.state)).toEqual(["cancel-requested", "queued"]);
  });

  it("停止当前尝试返回 cancel-requested", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/skill/step/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "canvas" })
    });
    const body = await response.json() as { ok: boolean; state: string };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: "cancel-requested" });
  });

  it("组外/跨 owner 读取被拒绝且不泄漏步骤", async () => {
    const { base } = await boot({ subject: "user-b" });
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/by-node?canvasId=canvas&nodeId=node`);
    const body = await response.json() as { step: unknown };
    expect(response.status).toBe(200);
    expect(body.step).toBeNull();
  });

  it("画布写权限缺失时拒绝重新生成", async () => {
    const { base } = await boot({ access: false });
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/skill/step/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "canvas", requestId: "req-2", prompt: "x" })
    });
    expect(response.status).toBe(401);
  });

  it("事件读取返回游标且不含提示词", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/skill-steps/skill/step?canvasId=canvas&after=0`);
    const body = await response.json() as { events: Array<{ state: string }>; cursor: number };
    expect(body.events.map((entry) => entry.state)).toEqual(["queued"]);
    expect(JSON.stringify(body.events)).not.toContain("一只猫");
    expect(body.cursor).toBeGreaterThan(0);
  });
});
