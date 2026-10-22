/**
 * 启动期结算的内容存在性判定（change: 2026-10-13-...，任务 11.2 / D1）。
 *
 * 回归点：结算不能把「只有 room 注册表能解析」当成内容存在——`registry.resolve` 会为任意 id
 * 加载空房间，若沿用它，reserve 后崩溃（内容未建）的预留会被误判为「内容已建」而 finalize 成
 * 无内容的孤儿 ACL。这里断言结算拿到的存在性来自持久化内容。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLifecyclePolicy } from "@woohaa3/contracts";
import { createCanvasService } from "./composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-reconcile-"));
  dirs.push(dir);
  return path.join(dir, "canvas.sqlite");
}

function envFor(dbPath: string): Record<string, string> {
  return {
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: dbPath,
    WOOHAA3_TASK_SERVICE_URL: "http://127.0.0.1:1",
    WOOHAA3_MEDIA_SERVICE_URL: "http://127.0.0.1:1"
  };
}

describe("启动期结算的内容存在性（任务 11.2 / D1）", () => {
  it("已建画布为 true；只有 room 可加载的空 id 为 false", async () => {
    const seen: Record<string, boolean> = {};
    const policy: ResourceLifecyclePolicy = {
      policyId: "test:reconcile",
      reserve: async () => ({ ok: true, aclRevision: 1 }),
      finalize: async () => ({ ok: true, aclRevision: 2 }),
      tombstone: async () => ({ ok: true }),
      reconcileProvisioning: async ({ exists, reservedBefore }) => {
        seen["c-real"] = await exists("c-real");
        seen["c-ghost"] = await exists("c-ghost");
        return { finalized: reservedBefore ? ["c-real"] : [], cleaned: [], failed: [] };
      }
    };
    const service = await createCanvasService({
      env: envFor(tempDb()),
      resourceLifecyclePolicy: () => policy,
      authenticate: async () => ({ subject: "tester", identityProvider: "test" })
    });
    await service.composition?.service.createCanvas({ canvasId: "c-real", title: "真实内容" });

    const result = await service.reconcileProvisioningReservations({ reservedBefore: new Date().toISOString() });

    expect(seen).toEqual({ "c-real": true, "c-ghost": false });
    expect(result).toEqual({ finalized: ["c-real"], cleaned: [], failed: [] });
    await service.close();
  }, 30_000);

  it("未注入生命周期提供者时不结算（默认无鉴权 组合）", async () => {
    const service = await createCanvasService({
      env: envFor(tempDb()),
      authenticate: async () => ({ subject: "tester", identityProvider: "test" })
    });
    expect(await service.reconcileProvisioningReservations()).toBeNull();
    await service.close();
  }, 30_000);
});
