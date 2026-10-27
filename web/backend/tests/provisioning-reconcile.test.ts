/**
 * 创建崩溃恢复的宿主装配（change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 11.2 / D1）。
 *
 * 验证：统一后端在启动时调用生命周期提供者的 `reconcileProvisioning`，并把**真实的画布内容存在性**
 * 交给提供者裁决（内容已建 → 补 finalize；内容不存在 → 清理预留）；未注入该能力的提供者不影响启动。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLifecyclePolicy } from "@woohaa3/contracts";
import { createControlledBackendService as createBackendService } from "./support/controlled-backend.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-provisioning-reconcile-"));
  dirs.push(dir);
  return dir;
}

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key: string) {
      return objects.get(key)!;
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async stat(key: string) {
      const record = objects.get(key);
      if (!record) throw new Error("missing");
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key: string) {
      return `https://cos.invalid/${key}?sign=test`;
    }
  };
}

/** 只实现 reserve/finalize/tombstone 的最小生命周期策略（不带崩溃恢复能力）。 */
function bareLifecycle(policyId: string): ResourceLifecyclePolicy {
  return {
    policyId,
    reserve: async () => ({ ok: true, aclRevision: 1 }),
    finalize: async () => ({ ok: true, aclRevision: 2 }),
    tombstone: async () => ({ ok: true })
  };
}

function baseOptions(dir: string) {
  return {
    env: {
      WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
      WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"),
      WOOHAA3_DEV_IDENTITY_SUBJECT: "reconcile-test-user"
    },
    modelsConfig: { version: 1 as const, models: [] },
    mediaStorage: memoryStorage() as never,
    enableYjsSync: false
  };
}

describe("启动期结算遗留 provisioning 预留（任务 11.2 / D1）", () => {
  it("宿主把真实内容存在性交给提供者：已建内容为 true，不存在为 false", async () => {
    const dir = tempDir();
    // 第一次启动：建一张画布，模拟「内容已落库」的历史状态。
    const first = await createBackendService({ ...baseOptions(dir), seedProviders: { resourceLifecycle: bareLifecycle("test:lifecycle-1") } });
    await first.modules().canvas.composition!.service.createCanvas({ canvasId: "c-built", title: "已建" });
    await first.close();

    // 第二次启动：记录提供者拿到的存在性判定与宽限边界。
    const seen: { reservedBefore?: string; exists: Record<string, boolean> } = { exists: {} };
    const policy: ResourceLifecyclePolicy = {
      ...bareLifecycle("test:lifecycle-2"),
      reconcileProvisioning: async ({ exists, reservedBefore }) => {
        seen.reservedBefore = reservedBefore;
        seen.exists["c-built"] = await exists("c-built");
        seen.exists["c-ghost"] = await exists("c-ghost");
        return { finalized: ["c-built"], cleaned: ["c-ghost"], failed: [] };
      }
    };
    const second = await createBackendService({ ...baseOptions(dir), seedProviders: { resourceLifecycle: policy } });

    expect(seen.reservedBefore).toBeDefined();
    expect(Number.isNaN(Date.parse(seen.reservedBefore!))).toBe(false);
    expect(seen.exists).toEqual({ "c-built": true, "c-ghost": false });
    await second.close();
  }, 30_000);

  it("提供者未实现 reconcileProvisioning 时启动不受影响", async () => {
    const dir = tempDir();
    const service = await createBackendService({ ...baseOptions(dir), seedProviders: { resourceLifecycle: bareLifecycle("test:lifecycle-3") } });
    expect(service.modules().canvas).toBeTruthy();
    await service.close();
  }, 30_000);
});
