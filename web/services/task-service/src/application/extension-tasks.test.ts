import { describe, expect, it, vi } from "vitest";
import type { TaskExtensionTaskApiDependencies } from "../api/extension-task-api.js";
import { createExtensionTaskFacade } from "./extension-tasks.js";

function harness() {
  const ownership = new Map<string, string>();
  const text = "x".repeat(20000);
  const deps = {
    associations: { find: (key: string) => ownership.has(key) ? { extensionId: ownership.get(key) } : undefined },
    resolveCatalog: async () => ({ available: true, defaultModels: {}, models: [{ modelKey: "language", modelType: "language", bindings: [], inputSchema: {} }] }),
    submit: vi.fn(async (request, owner) => { ownership.set(request.workerTaskKey, owner.extensionId); return { reused: false, state: "queued" }; }),
    history: { get: vi.fn((_key, options) => ({ state: "succeeded", result: { text: options?.fullText ? text : text.slice(0, 100) } })) },
    status: vi.fn(async () => ({ state: "running" })),
    cancel: vi.fn(async () => "cancelled")
  } satisfies Record<string, unknown>;
  const facade = (id: string, version = 7) => createExtensionTaskFacade(deps as unknown as TaskExtensionTaskApiDependencies, id, version);
  return { deps, ownership, text, facade };
}

const input = { workerTaskKey: "work", modelType: "language", modelKey: "language", prompt: "游戏", parameters: {} };

describe("进程内扩展任务端口", () => {
  it("绑定真实扩展/版本及非画布关联，完整源码不被历史摘要截断", async () => {
    const h = harness();
    expect(await h.facade("game-furnace").submit(input)).toMatchObject({ ok: true, state: "queued" });
    expect(h.deps.submit).toHaveBeenCalledWith(expect.objectContaining({ canvasId: "plugin", nodeId: "game-furnace", nodeType: "text" }), { extensionId: "game-furnace", configVersion: 7 });
    expect(await h.facade("game-furnace").result!("work")).toMatchObject({ result: { text: h.text } });
    expect(await h.facade("game-furnace").cancel("work")).toEqual({ workerTaskKey: "work", state: "cancelled" });
  });
  it("跨扩展查询、取消及同 key 提交均被拒绝，不改写 owner", async () => {
    const h = harness();
    await h.facade("owner").submit(input);
    const foreign = h.facade("other");
    expect(await foreign.status("work")).toBeNull();
    expect(await foreign.result!("work")).toBeNull();
    expect(await foreign.cancel("work")).toBeNull();
    expect(await foreign.submit(input)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(h.deps.submit).toHaveBeenCalledTimes(1);
    expect(h.ownership.get("work")).toBe("owner");
  });
  it("向任务所属扩展返回已脱敏的失败摘要", async () => {
    const h = harness();
    await h.facade("owner").submit(input);
    h.deps.history.get.mockReturnValueOnce({
      state: "failed",
      error: { name: "ProviderHttpError", message: "request rejected", status: 400, code: "InputTextSensitiveContentDetected" }
    } as never);
    expect(await h.facade("owner").result!("work")).toMatchObject({
      state: "failed",
      error: { status: 400, code: "InputTextSensitiveContentDetected" }
    });
  });
  it("非法画布关联、无可用模型和不支持的媒体不触发 submit", async () => {
    const h = harness();
    const f = h.facade("game-furnace");
    expect(await f.submit({ ...input, canvasId: "c" } as never)).toMatchObject({ ok: false });
    expect(await f.submit({ ...input, modelKey: "missing" })).toMatchObject({ ok: false });
    expect(await f.submit({ ...input, inputs: [{ assetId: "asset", role: "image", storageKey: `sha256-${"a".repeat(64)}`, mediaType: "image/png", mediaKind: "image" }] })).toMatchObject({ ok: false });
    expect(h.deps.submit).not.toHaveBeenCalled();
  });
});
