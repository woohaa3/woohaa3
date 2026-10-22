/**
 * Canvas script 部署装配接线测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 4.1）。
 *
 * 验证**真实** `createCanvasService` 装配出的 `mcpServices().agent` 脚本能力面与部署 env 一致：
 * 授权端口齐备（无任何额外密钥）时 available；`WOOHAA3_CANVAS_SCRIPT_ENGINE=0` 时声明隔离
 * 执行器不可用。脚本可用性不再依赖任何提交凭证密钥。非渲染检查。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "./sync/index.js";
import { SqliteCanvasRepository } from "./storage/sqlite/index.js";
import { createCanvasService } from "./composition.js";
import { createCanvasAccessPort } from "./access/access-port.js";

const NOW = "2026-10-13T00:00:00.000Z";
const CANVAS = "c-script-wiring";
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-script-wiring-"));
  dirs.push(dir);
  return path.join(dir, name);
}

async function agent(scriptEnv: Record<string, string>) {
  const repository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
  const service = await createCanvasService({
    env: {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
      WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: "wiring-token",
      ...scriptEnv
    },
    enableModelMcp: true,
    repository,
    yjsRepository: new InMemoryYjsDocumentRepository(),
    now: () => NOW,
    access: createCanvasAccessPort(async () => ({ allowed: true })),
    mediaClient: { async verify() { return { exists: true, matches: true }; } },
    taskClient: { async submit() { throw new Error("not used"); } } as never
  });
  closers.push(async () => { await service.close(); repository.close(); });
  const agentService = service.mcpServices().agent;
  if (!agentService) throw new Error("AgentCanvasInternalService 未装配");
  return agentService;
}

describe("Canvas script 部署装配（任务 4.1）", () => {
  it("默认装配（授权齐备、无额外密钥）时能力 available", async () => {
    const agentService = await agent({});
    expect(await agentService.scriptCapability({ principalId: "dev-user", canvasId: CANVAS }))
      .toMatchObject({ ok: true, available: true });
  });

  it("WOOHAA3_CANVAS_SCRIPT_ENGINE=0 时声明隔离执行器不可用", async () => {
    const agentService = await agent({
      WOOHAA3_CANVAS_SCRIPT_ENGINE: "0"
    });
    expect(await agentService.scriptCapability({ principalId: "dev-user", canvasId: CANVAS }))
      .toMatchObject({ ok: true, available: false, reason: expect.stringContaining("禁用") });
  });
});
