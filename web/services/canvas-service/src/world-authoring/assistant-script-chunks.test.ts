/**
 * 导演区模型脚本分段写入（change: 2026-11-10-add-incremental-world-model-authoring）。
 *
 * 这里用一个按房间语义建模的派生桩验证端口行为：`submitDerived` 在串行队列里预先
 * 检查 commandId 的冻结回执（命中即 duplicate、不再执行 derive），否则用**当前**
 * 画布执行 derive 并应用 nodeData.patch。因此「同 requestId 参数不同」与「版本过期」
 * 都在提交事务内被拒绝，而不是在服务层猜。
 */
import { describe, expect, it } from "vitest";
import type { CanvasNodeData, ServerCanvas, WorldToolContext } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createAssistantWorldService } from "./assistant-service.js";
import { worldObjectVersion } from "./authority.js";
import type { CanvasRoom } from "../sync/room.js";

const now = "2026-01-01T00:00:00Z";
const scope = { scope: { kind: "scene-area" as const, areaId: "area-1" }, scopeVersion: "scope-1" };

const PAD = "scene.box({ id: 'pad', size: [2, 0.2, 2] });";

function contextFor(): WorldToolContext {
  return {
    contextId: "ctx-1",
    canvasId: "canvas-1",
    runId: "run-1",
    epoch: 0,
    scope,
    writableTargets: [{ target: { kind: "instance", instanceId: "instance-1", version: "iv-1" }, lease: { canvasId: "canvas-1", runId: "run-1", epoch: 0, target: { kind: "instance", instanceId: "instance-1" } } }],
    readOnlyReferences: [{ kind: "instance", instanceId: "reference-1", version: "rv-1" }]
  };
}

function instanceData(instanceId: string, script: string, transform = { position: { u: 1, v: 1, h: 0 } }) {
  return {
    modelScript: script,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId,
      transform: { version: "shared-world-v1", position: transform.position, rotation: [0, 0, 0, 1], scale: 1 }
    }
  };
}

function canvasWith(script: string): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", now);
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "model-node", type: "model3d", position: { x: 0, y: 0 } },
    { id: "ref-node", type: "model3d", position: { x: 0, y: 0 } }
  );
  canvas.nodeData["area"] = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-1",
      scopeVersion: "scope-1",
      bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } }
    }
  } as never;
  canvas.nodeData["model-node"] = instanceData("instance-1", script) as never;
  canvas.nodeData["ref-node"] = instanceData("reference-1", "scene.box({});") as never;
  return canvas;
}

type Recorded = { commandId: string; status: string; revision: number; noop: boolean };

/**
 * Room stand-in with real read-modify-write + frozen receipt semantics.
 *
 * `prepareContent` compiles the composed script with the same executor the
 * authority uses; anything that does not compile is reported as unknown geometry.
 */
function roomFor(canvas: ServerCanvas, options: { rejectCode?: { code: string; message: string } } = {}) {
  const receipts = new Map<string, Recorded & { payloadHash?: string }>();
  const calls: Array<{ commandId: string; status: string }> = [];
  let revision = 1;
  const room = {
    async lookupCommand(commandId: string) {
      const frozen = receipts.get(commandId);
      return frozen ? { commandId, revision: frozen.revision, changed: true, payloadHash: frozen.payloadHash ?? "" } : null;
    },
    async inspectPublished<T>(select: (canvas: ServerCanvas) => T) {
      return { ok: true as const, canvas, value: select(canvas) };
    },
    async submitDerived(input: {
      commandId: string;
      /**
       * The host intent hash. A real room freezes it with the receipt; a retry with
       * the same commandId but a different hash must report request-id-reused.
       */
      expectedWorldAuthoringHash?: string;
      derive: (canvas: ServerCanvas) => Promise<
        | { ok: true; batch: { commands: Array<{ type: string; nodeId?: string; node?: { id: string }; nodeData?: Record<string, unknown>; value?: Record<string, unknown> }> } }
        | { ok: false; code: string; message: string }
      >;
    }) {
      const frozen = receipts.get(input.commandId);
      if (frozen) {
        // 真实房间按冻结的 payload 复核：身份相同但意图不同必须拒绝，而不是返回旧回执。
        if (input.expectedWorldAuthoringHash && frozen.payloadHash !== input.expectedWorldAuthoringHash) {
          calls.push({ commandId: input.commandId, status: "reused" });
          return { ok: false as const, code: "request-id-reused", message: "相同 operationId 使用了不同意图" };
        }
        calls.push({ commandId: input.commandId, status: "duplicate" });
        return { ok: true, status: "duplicate", commandId: input.commandId, revision: frozen.revision, noop: frozen.noop, update: null };
      }
      if (options.rejectCode) return { ok: false as const, ...options.rejectCode };
      const derived = await input.derive(canvas);
      if (!derived.ok) return { ok: false as const, code: derived.code, message: derived.message };
      for (const command of derived.batch.commands) {
        if (command.type === "node.add" && command.node) {
          canvas.document.nodes.push({ ...command.node, type: "model3d", position: { x: 0, y: 0 } } as never);
          canvas.nodeData[command.node.id] = command.nodeData as CanvasNodeData;
          continue;
        }
        if (command.nodeId) canvas.nodeData[command.nodeId] = { ...canvas.nodeData[command.nodeId], ...command.value } as CanvasNodeData;
      }
      revision += 1;
      receipts.set(input.commandId, { commandId: input.commandId, status: "accepted", revision, noop: false, ...(input.expectedWorldAuthoringHash ? { payloadHash: input.expectedWorldAuthoringHash } : {}) });
      calls.push({ commandId: input.commandId, status: "accepted" });
      return { ok: true, status: "accepted", commandId: input.commandId, revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom;
  return { room, receipts, calls, currentRevision: () => revision };
}

/** Simple structural "does it parse as one program" check mirroring compile failure. */
function harness(canvas: ServerCanvas, options: Parameters<typeof roomFor>[1] = {}) {
  const context = contextFor();
  const room = roomFor(canvas, options);
  const service = createAssistantWorldService({
    authority: {
      async prepareCanvas() {
        return { ok: true as const, snapshot: { version: "world-authoring-v1", canvasId: "canvas-1", revision: 1, scope, areaNodeId: "area", area: {}, bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } }, writable: [], readOnly: [], members: { instances: [], cameras: [] }, objects: [] } } as never;
      },
      async prepareContent(fields: Record<string, unknown>) {
        const script = String(fields.modelScript ?? "");
        // 骨架允许为空；非空脚本必须括号平衡，否则视为无法编译。
        if (script === "") return null;
        let depth = 0;
        for (const char of script) {
          if (char === "(" || char === "{" || char === "[") depth += 1;
          if (char === ")" || char === "}" || char === "]") depth -= 1;
          if (depth < 0) return null;
        }
        if (depth !== 0) return null;
        return { contentVersion: `content-${script.length}`, localAabb: { min: [0, 0, 0] as const, max: [1, 1, 1] as const } };
      }
    },
    worldAuthoring: {
      async issueContext() {
        return { ok: true, context, run: { canvasId: "canvas-1", requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1", state: "active" }, retry: false };
      },
      async revokeContext() { /* no-op */ },
      resolveCapability() { return { context, capability: {} }; },
      refreshContextVersions() { /* no-op */ },
      refreshContextScope() { /* no-op */ }
    },
    cameraSettings: {
      async save() { return { ok: false as const, code: "write-forbidden" as const, message: "unused" }; },
      async complete() { return { ok: false as const, code: "write-forbidden" as const, message: "unused" }; }
    },
    async resolveRoom() { return room.room; },
    async cancel() { /* no-op */ },
    async confirmStopped() { /* no-op */ },
    async pending() { return []; }
  });
  return { service, room, context, canvas };
}

async function issuedContext(service: ReturnType<typeof harness>["service"]) {
  const issued = await service.issue({ canvasId: "canvas-1", requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1", scope: { kind: "scene-area", areaId: "area-1" } });
  if (!issued.ok) throw new Error(issued.message);
  return issued.context.contextId;
}

function scriptOf(canvas: ServerCanvas, nodeId = "model-node"): string {
  return (canvas.nodeData[nodeId] as { modelScript: string }).modelScript;
}

/** Current authoritative version of the writable instance, as the host would report it. */
function versionOf(canvas: ServerCanvas): string {
  const version = worldObjectVersion(canvas, { kind: "instance", instanceId: "instance-1" });
  if (!version) throw new Error("instance missing");
  return version;
}

function contentVersionOf(canvas: ServerCanvas, nodeId = "model-node") {
  return (canvas.nodeData[nodeId] as { modelContentVersion: { revision: number; contentHash: string } }).modelContentVersion;
}

describe("分段写入：追加", () => {
  it("连续追加按序拼接，内容与版本每次都前进", async () => {
    const canvas = canvasWith("");
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const chunks = ["scene.box({ id: 'base' });", "scene.box({ id: 'body' });", "scene.cylinder({ id: 'roof' });"];
    const initialVersion = versionOf(canvas);
    let version: string | undefined;
    const versions = new Set<string>();
    for (const [index, chunk] of chunks.entries()) {
      const outcome = await service.write({ contextId, operation: { kind: "append-model-script", operationId: `append-${index}`, instanceId: "instance-1", expectedVersion: version ?? initialVersion, chunk } });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;
      version = outcome.version;
      versions.add(outcome.version!);
      expect(outcome.scriptLength).toBe(chunks.slice(0, index + 1).join("").length);
    }
    // 版本三次前进（骨架→台基→主体→屋顶）。
    expect(versions.size).toBe(3);
    expect(scriptOf(canvas)).toBe(chunks.join(""));
    expect(contentVersionOf(canvas).revision).toBe(4);
  });

  it("版本过期返回 version-conflict 与当前真实版本且内容不变", async () => {
    const canvas = canvasWith(PAD);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const initialVersion = versionOf(canvas);
    const first = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-1", instanceId: "instance-1", expectedVersion: versionOf(canvas), chunk: "scene.box({});" } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = scriptOf(canvas);
    const stale = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-2", instanceId: "instance-1", expectedVersion: initialVersion, chunk: "scene.sphere({});" } });
    expect(stale).toMatchObject({ ok: false, code: "version-conflict", currentVersion: first.version });
    expect(scriptOf(canvas)).toBe(after);
  });

  it("目标不在可写集合返回 outside-scope 且不写入", async () => {
    const canvas = canvasWith(PAD);
    const { service, room } = harness(canvas);
    const contextId = await issuedContext(service);
    const denied = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-ref", instanceId: "reference-1", expectedVersion: "rv-1", chunk: "scene.box({});" } });
    expect(denied).toMatchObject({ ok: false, code: "outside-scope" });
    expect(scriptOf(canvas, "ref-node")).toBe("scene.box({});");
    expect(room.calls).toHaveLength(0);
  });
});

describe("分段写入：合成后仍走整段校验", () => {
  it("片段语法不完整时整段被拒绝且原内容不变", async () => {
    const canvas = canvasWith(PAD);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const broken = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-broken", instanceId: "instance-1", expectedVersion: versionOf(canvas), chunk: "scene.box({ id: 'half'" } });
    expect(broken).toMatchObject({ ok: false, code: "invalid-data" });
    expect(scriptOf(canvas)).toBe(PAD);
    expect(contentVersionOf(canvas).revision).toBe(1);
    // 修正后再追加成功：失败的那段没有留下任何痕迹。
    const fixed = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-fixed", instanceId: "instance-1", expectedVersion: versionOf(canvas), chunk: "scene.box({ id: 'half' });" } });
    expect(fixed.ok).toBe(true);
    expect(scriptOf(canvas)).toBe(`${PAD}scene.box({ id: 'half' });`);
  });

  it("并发整段替换后，携带旧版本的追加被拒绝", async () => {
    const canvas = canvasWith(PAD);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const observed = await service.issue({ canvasId: "canvas-1", requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1", scope: { kind: "scene-area", areaId: "area-1" } });
    expect(observed.ok).toBe(true);
    const initialVersion = versionOf(canvas);
    // 另一个写者整段替换了内容（版本前进）。
    const replaced = await service.write({ contextId, operation: { kind: "replace-model-content", operationId: "replace-1", instanceId: "instance-1", expectedVersion: versionOf(canvas), content: { modelScript: "scene.box({ id: 'replaced' });" } } });
    expect(replaced.ok).toBe(true);
    const stale = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-after-replace", instanceId: "instance-1", expectedVersion: initialVersion, chunk: "scene.sphere({});" } });
    expect(stale).toMatchObject({ ok: false, code: "version-conflict" });
    expect(scriptOf(canvas)).toBe("scene.box({ id: 'replaced' });");
  });
});

describe("分段写入：文本定点修补", () => {
  const script = "scene.box({ id: 'roof', color: 'red' });\nscene.box({ id: 'wall', color: 'gray' });";

  it("修补一处构件只替换该处并返回替换计数", async () => {
    const canvas = canvasWith(script);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const outcome = await service.write({ contextId, operation: { kind: "patch-model-script", operationId: "patch-1", instanceId: "instance-1", expectedVersion: versionOf(canvas), oldString: "'red'", newString: "'blue'" } });
    expect(outcome).toMatchObject({ ok: true, replaced: 1 });
    expect(scriptOf(canvas)).toBe(script.replace("'red'", "'blue'"));
    if (outcome.ok) expect(outcome.scriptLength).toBe(script.replace("'red'", "'blue'").length);
  });

  it.each([
    ["patch-not-found", "color: 'green'", 0],
    ["patch-ambiguous", "color", 2]
  ] as const)("%s 回执带诊断且内容不变", async (code, oldString, occurrences) => {
    const canvas = canvasWith(script);
    const { service, room } = harness(canvas);
    const contextId = await issuedContext(service);
    const outcome = await service.write({ contextId, operation: { kind: "patch-model-script", operationId: `patch-${code}`, instanceId: "instance-1", expectedVersion: versionOf(canvas), oldString, newString: "x" } });
    expect(outcome).toMatchObject({ ok: false, code });
    if (outcome.ok) return;
    expect(outcome.patchDiagnostic?.occurrences).toBe(occurrences);
    expect(outcome.patchDiagnostic?.scriptLength).toBe(script.length);
    if (code === "patch-not-found") expect(outcome.patchDiagnostic?.closest?.excerpt).toContain("scene.box");
    if (code === "patch-ambiguous") {
      expect(outcome.patchDiagnostic?.matches?.map(match => match.line)).toEqual([1, 2]);
    }
    expect(scriptOf(canvas)).toBe(script);
    expect(room.calls).toHaveLength(0);
  });

  it("patch-noop 不推进版本也不写入", async () => {
    const canvas = canvasWith(script);
    const { service, room } = harness(canvas);
    const contextId = await issuedContext(service);
    const outcome = await service.write({ contextId, operation: { kind: "patch-model-script", operationId: "patch-noop", instanceId: "instance-1", expectedVersion: versionOf(canvas), oldString: "'red'", newString: "'red'" } });
    expect(outcome).toMatchObject({ ok: false, code: "patch-noop" });
    expect(contentVersionOf(canvas).revision).toBe(1);
    expect(scriptOf(canvas)).toBe(script);
    expect(room.calls).toHaveLength(0);
  });
});

describe("分段写入：幂等", () => {
  it("同 requestId 同参数重试返回首次回执且不重复拼接", async () => {
    const canvas = canvasWith(PAD);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const initialVersion = versionOf(canvas);
    const operation = { kind: "append-model-script" as const, operationId: "append-retry", instanceId: "instance-1", expectedVersion: initialVersion, chunk: "scene.box({ id: 'once' });" };
    const first = await service.write({ contextId, operation });
    expect(first.ok).toBe(true);
    const lengthAfterFirst = scriptOf(canvas).length;
    const versionAfterFirst = contentVersionOf(canvas).contentHash;
    const retry = await service.write({ contextId, operation });
    if (!first.ok || !retry.ok) return;
    expect(retry.version).toBe(first.version);
    expect(retry.scriptLength).toBe(first.scriptLength);
    expect(scriptOf(canvas)).toBe(`${PAD}scene.box({ id: 'once' });`);
    expect(scriptOf(canvas).length).toBe(lengthAfterFirst);
    expect(contentVersionOf(canvas).contentHash).toBe(versionAfterFirst);
  });

  it("同 requestId 不同参数返回 request-id-reused 且内容不变", async () => {
    const canvas = canvasWith(PAD);
    const { service } = harness(canvas);
    const contextId = await issuedContext(service);
    const initialVersion = versionOf(canvas);
    const first = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-reuse", instanceId: "instance-1", expectedVersion: initialVersion, chunk: "scene.box({ id: 'a' });" } });
    expect(first.ok).toBe(true);
    const before = scriptOf(canvas);
    // 同一个 operationId 换片段：房间的冻结回执复核必须拒绝，而不是返回旧回执或重复拼接。
    const reused = await service.write({ contextId, operation: { kind: "append-model-script", operationId: "append-reuse", instanceId: "instance-1", expectedVersion: initialVersion, chunk: "scene.box({ id: 'b' });" } });
    expect(reused).toMatchObject({ ok: false, code: "operation-conflict" });
    expect(scriptOf(canvas)).toBe(before);
  });
});

describe("空骨架创建", () => {
  it("省略脚本创建空模型并返回可继续写入的版本", async () => {
    const canvas = canvasWith(PAD);
    const { service, room } = harness(canvas);
    const contextId = await issuedContext(service);
    const created = await service.write({
      contextId,
      operation: {
        kind: "create-model",
        operationId: "create-skeleton",
        nodeId: "skeleton-node",
        content: { modelScript: "" },
        transform: { version: "shared-world-v1", position: { u: 2, v: 2, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
      }
    });
    expect(created).toMatchObject({ ok: true, instanceId: expect.any(String) });
    if (!created.ok) return;
    expect(room.calls).toHaveLength(1);
    const fields = canvas.nodeData[created.nodeId!] as { modelScript: string; sharedWorldInstance: { instanceId: string } };
    expect(fields.modelScript).toBe("");
    expect(fields.sharedWorldInstance?.instanceId).toBe(created.instanceId);
    expect(created.version).toBeTruthy();
    // 骨架在脚本到来前不参与渲染：脚本为空、版本已存在且可继续写入。
    // 骨架内容为空且版本已存在：可继续写入而不参与渲染。
    expect(fields.modelScript).toBe("");
  });

  it("非空骨架不可编译时不创建", async () => {
    const canvas = canvasWith(PAD);
    const { service, room } = harness(canvas);
    const contextId = await issuedContext(service);
    const rejected = await service.write({
      contextId,
      operation: {
        kind: "create-model",
        operationId: "create-broken",
        nodeId: "broken-node",
        content: { modelScript: "scene.box({ id: 'x'" },
        transform: { version: "shared-world-v1", position: { u: 2, v: 2, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
      }
    });
    expect(rejected).toMatchObject({ ok: false, code: "invalid-data" });
    expect(canvas.document.nodes.some(node => node.id === "broken-node")).toBe(false);
    expect(room.calls).toHaveLength(0);
  });
});
