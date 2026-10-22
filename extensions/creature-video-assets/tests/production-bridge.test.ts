import { describe, expect, it, vi } from "vitest";
import type { ApplicationBackendHost } from "@woohaa3/contracts";
import { createLegacyProductionBridge as createProductionBridge, PRODUCTION_CHECKS } from "../src/authoring/backend/production-bridge.js";
import { createRun } from "../src/state/shared/workflow.js";

describe("制作工具边界", () => {
  const run = () => createRun("canvas", "workflow", "instance-123");
  function harness() {
    const verify = vi.fn(async () => ({ exists: true, metadata: { checksum: "sha", size: 200, contentType: "image/png" } }));
    const host = { config: { values: () => ({ productionWorker: { executable: process.execPath, args: [] } }) }, services: { media: { verify } } } as unknown as ApplicationBackendHost;
    const invoke = vi.fn(async (_executable: string, _args: string[], input: unknown) => {
      const request = input as { operationKey: string; stageId: string; revision: number; gate: string };
      return { protocol: "creature-production.v1", ...request, status: "complete", structured: {}, artifacts: [{ id: "master", kind: "image", title: "母方向", storageKey: "master.png", checksum: "sha", size: 200, contentType: "image/png" }], checks: PRODUCTION_CHECKS["05_direction_stills"].map(id => ({ id, passed: true, evidenceIds: ["master"] })) };
    });
    return { host, verify, invoke };
  }
  it("缺配置明确阻断，不伪造媒体", async () => {
    const h = harness(); h.host.config.values = () => ({});
    const context = { run: run(), stageId: "05_direction_stills" as const, checkpoint: vi.fn(), assertCurrent: vi.fn(), isStopped: () => false };
    await expect(createProductionBridge(h.host, h.invoke)(context)).rejects.toMatchObject({ code: "production-not-configured" });
    expect(h.invoke).not.toHaveBeenCalled(); expect(context.run.stages[context.stageId].operations).toHaveLength(0);
  });
  it("逐项核验媒体与 QA 证据，未知操作沿用身份并只对账", async () => {
    const h = harness();
    // Worker response only returns the versioned envelope, never copies the request fields.
    h.invoke.mockImplementation(async (_e, _a, input) => {
      const r = input as { operationKey: string; stageId: string; revision: number; gate: string };
      return { protocol: "creature-production.v1", operationKey: r.operationKey, stageId: r.stageId, revision: r.revision, gate: r.gate, status: "complete", structured: {}, artifacts: [{ id: "master", kind: "image", title: "母方向", storageKey: "master.png", checksum: "sha", size: 200, contentType: "image/png" }], checks: PRODUCTION_CHECKS["05_direction_stills"].map(id => ({ id, passed: true, evidenceIds: ["master"] })) };
    });
    const context = { run: run(), stageId: "05_direction_stills" as const, checkpoint: vi.fn(), assertCurrent: vi.fn(), isStopped: () => false };
    const bridge = createProductionBridge(h.host, h.invoke);
    expect((await bridge(context)).checks.hardPassed).toBe(true);
    expect(h.verify).toHaveBeenCalledWith("master.png");
    await bridge(context);
    const requests = h.invoke.mock.calls.map(call => call[2] as { mode: string; operationKey: string });
    expect(requests.map(item => item.mode)).toEqual(["execute", "reconcile"]);
    expect(requests[0]!.operationKey).toBe(requests[1]!.operationKey);
    h.verify.mockResolvedValue({ exists: true, metadata: { checksum: "wrong", size: 200, contentType: "image/png" } });
    await expect(bridge(context)).rejects.toMatchObject({ code: "production-qa-required" });
  });
});
