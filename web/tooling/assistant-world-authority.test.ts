import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WORLD_TOOL,
  assistantWorldToolsForScope,
  decodeAssistantWorldWriteInput
} from "@woohaa3/contracts";
import { createAssistantWorldService } from "@woohaa3/canvas-service";
import type { ServerCanvas, WorldToolContext } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";

const scope = { scope: { kind: "workflow-group-2d" as const, groupId: "group-1" }, scopeVersion: "g-1" };
const context: WorldToolContext = {
  contextId: "ctx-1",
  canvasId: "canvas-1",
  runId: "run-1",
  epoch: 0,
  scope,
  writableTargets: [],
  readOnlyReferences: [{ kind: "instance", instanceId: "instance-1", version: "iv-1" }]
};

describe("scoped assistant world authority across packages", () => {
  it("exposes exactly one read-only group tool and the full scene-area catalog", () => {
    expect(assistantWorldToolsForScope({ kind: "workflow-group-2d", groupId: "group-1" })).toEqual([ASSISTANT_WORLD_TOOL.readContext]);
    expect(assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" })).toContain(ASSISTANT_WORLD_TOOL.createModel);
  });

  it("denies world writes from the group context even when the caller supplies a write operation", async () => {
    const service = createAssistantWorldService({
      authority: {
        async prepareCanvas() { return { ok: false as const, code: "not-ready" as const, message: "not used" }; },
        async prepareContent() { return null; }
      },
      worldAuthoring: {
        async issueContext() {
          return { ok: true, context, run: { canvasId: "canvas-1", requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1", state: "active" }, retry: false };
        },
        async revokeContext() { /* no-op */ },
        resolveCapability() { return { context, capability: {} }; },
        refreshContextVersions() { /* no-op */ }
      },
      cameraSettings: {
        async save() { return { ok: false as const, code: "write-forbidden" as const, message: "not used" }; },
        async complete() { return { ok: false as const, code: "write-forbidden" as const, message: "not used" }; }
      },
      async resolveRoom() {
        return {
          async inspectPublished<T>(select: (canvas: ServerCanvas) => T) {
            const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-01-01T00:00:00Z");
            return { ok: true as const, canvas, value: select(canvas) };
          }
        } as never;
      },
      async cancel() { /* no-op */ },
      async confirmStopped() { /* no-op */ },
      async pending() { return []; }
    });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "workflow-group-2d", groupId: "group-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const decoded = decodeAssistantWorldWriteInput({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-model-transform",
        operationId: "move-1",
        instanceId: "instance-1",
        expectedVersion: "iv-1",
        transform: { version: "shared-world-v1", position: { u: 1, v: 1, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
      }
    });
    if (!decoded.ok) throw new Error(decoded.message);
    await expect(service.write(decoded.value)).resolves.toMatchObject({ ok: false, code: "capability-unsupported" });
  });
});
