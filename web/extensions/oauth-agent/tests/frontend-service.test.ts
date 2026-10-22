/**
 * ChatGPT 授权/生成 Service 测试（extension 前端 owner）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1；由宿主
 *  `cordis/plugins/chatgpt/service.test.ts` 迁入）。
 *
 * 覆盖：授权状态、模型目录、按目标隔离草稿/运行、切换目标不复用身份、断开清除展示、取消、
 * requestId 与权威回执（不提前显示成功）。
 */
import { describe, expect, it, vi } from "vitest";
import { createChatGptService } from "../src/frontend/service.js";
import type { ChatGptGenerationSink, ChatGptRemote } from "../src/frontend/remote.js";
import type { ChatGptGenerationReceipt } from "@woohaa3/contracts";

function remoteStub() {
  let sink: ChatGptGenerationSink | null = null;
  let lastRequest: Record<string, unknown> | null = null;
  let cancelled = false;
  const remote: ChatGptRemote = {
    fetchStatus: async () => ({ ok: true, snapshot: { state: "ready", planEnabled: true, localSession: true, ownerKind: "local-session" } }),
    startAuthorize: async () => ({ ok: true, url: "https://auth.example/authorize?state=1" }),
    disconnect: async () => ({ ok: true, snapshot: { state: "disconnected", planEnabled: false, localSession: true, ownerKind: "local-session" } }),
    fetchModels: async () => ({ ok: true, snapshot: { models: [{ id: "gpt-5", label: "GPT-5" }] } }),
    generate: (input, nextSink) => {
      sink = nextSink;
      lastRequest = input;
      cancelled = false;
      return { cancel: () => { cancelled = true; } };
    },
    receipt: async () => ({ ok: true, receipt: { status: "unknown", requestId: "x" } })
  };
  return {
    remote,
    emit: (receipt: ChatGptGenerationReceipt) => sink?.done?.(receipt),
    progress: (stage: string) => sink?.progress?.({ requestId: "r", stage }),
    lastRequest: () => lastRequest,
    isCancelled: () => cancelled
  };
}

describe("ChatGPT Service", () => {
  it("getSnapshot 返回稳定引用（useSyncExternalStore 不得触发无限循环）", async () => {
    const { remote } = remoteStub();
    const service = createChatGptService({ remote });
    await service.refresh();
    const first = service.getSnapshot();
    expect(service.getSnapshot()).toBe(first);
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    const second = service.getSnapshot();
    expect(service.getSnapshot()).toBe(second);
    expect(second).not.toBe(first);
    service.setDraft("x");
    expect(service.getSnapshot()).toBe(service.getSnapshot());
  });

  it("刷新授权状态并暴露 ready", async () => {
    const { remote } = remoteStub();
    const service = createChatGptService({ remote });
    await service.refresh();
    expect(service.isReady()).toBe(true);
    expect(service.getSnapshot().auth?.state).toBe("ready");
  });

  it("授权 ready 后 refresh 自动加载模型目录（无需面板挂载）", async () => {
    let calls = 0;
    const { remote } = remoteStub();
    const service = createChatGptService({
      remote: { ...remote, fetchModels: async () => { calls += 1; return { ok: true, snapshot: { models: [{ id: "gpt-5", label: "GPT-5" }] } }; } }
    });
    await service.refresh();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(service.getSnapshot().models[0]?.id).toBe("gpt-5");
  });

  it("草稿/运行按 {canvasId,nodeId,mode} 隔离，切换目标不复用", async () => {
    const { remote } = remoteStub();
    const service = createChatGptService({ remote, createRequestId: () => "req-1" });
    await service.refresh();
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    service.setDraft("box n1");
    service.generate({ model: "gpt-5", prompt: "box n1" });
    service.setTarget({ canvasId: "cv", nodeId: "n2", mode: "model3d" });
    expect(service.getSnapshot().draftPrompt).toBe("");
    expect(service.getSnapshot().run.phase).toBe("idle");
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    expect(service.getSnapshot().draftPrompt).toBe("box n1");
    expect(service.getSnapshot().run.phase).toBe("running");
  });

  it("推理完成不等于成功：只有权威回执 succeeded 才显示已提交", async () => {
    const { remote, emit } = remoteStub();
    const service = createChatGptService({ remote, createRequestId: () => "req-2" });
    await service.refresh();
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    service.generate({ model: "gpt-5", prompt: "x" });
    expect(service.getSnapshot().run.phase).toBe("running");
    emit({ status: "failed", requestId: "req-2", mode: "model3d", code: "invalid-candidate", message: "非法" });
    expect(service.getSnapshot().run).toMatchObject({ phase: "failed", message: "非法" });
    emit({ status: "succeeded", requestId: "req-2", mode: "model3d", canvasId: "cv", nodeId: "n1", commandId: "cmd-9" });
    expect(service.getSnapshot().run).toMatchObject({ phase: "succeeded", commandId: "cmd-9" });
  });

  it("生成捕获提交时目标身份（用户切换后不回投）", async () => {
    const { remote, lastRequest } = remoteStub();
    const service = createChatGptService({ remote, createRequestId: () => "req-3" });
    await service.refresh();
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "camera" });
    service.generate({ model: "gpt-5", prompt: "x", selectedCameraId: "cam-1" });
    service.setTarget({ canvasId: "cv", nodeId: "n2", mode: "camera" });
    expect(lastRequest()).toMatchObject({ nodeId: "n1", mode: "camera", selectedCameraId: "cam-1", requestId: "req-3" });
  });

  it("授权未就绪时不生成", async () => {
    const { remote } = remoteStub();
    const service = createChatGptService({ remote });
    // 未 refresh → auth null。
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    expect(service.generate({ model: "gpt-5", prompt: "x" })).toBeNull();
  });

  it("思考强度按目标保留，生成捕获当前选择，模型默认不发送覆盖参数", async () => {
    const { remote, lastRequest } = remoteStub();
    const service = createChatGptService({ remote });
    await service.refresh();
    const target = { canvasId: "cv", nodeId: "n1", mode: "model3d" as const };
    service.setTarget(target);
    expect(service.getSnapshot().reasoningEffort).toBe("default");
    service.generate({ model: "gpt-6.1-sol", prompt: "box" });
    expect(lastRequest()).not.toHaveProperty("reasoningEffort");
    service.setReasoningEffort("high");
    service.setTarget({ ...target, nodeId: "n2" });
    expect(service.getSnapshot().reasoningEffort).toBe("default");
    service.setTarget(target);
    expect(service.getSnapshot().reasoningEffort).toBe("high");
    service.generate({ model: "gpt-6.1-sol", prompt: "box" });
    service.setTarget({ ...target, nodeId: "n2" });
    service.setReasoningEffort("low");
    expect(lastRequest()).toMatchObject({ nodeId: "n1", reasoningEffort: "high" });
    service.setTarget(target);
    service.generate({ model: "gpt-6.1-sol", prompt: "box", reasoningEffort: "default" });
    expect(lastRequest()).not.toHaveProperty("reasoningEffort");
    await service.disconnect();
    expect(service.getSnapshot().reasoningEffort).toBe("default");
  });

  it("断开清除模型目录与草稿", async () => {
    const { remote } = remoteStub();
    const service = createChatGptService({ remote });
    await service.refresh();
    await service.loadModels();
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    service.setDraft("draft");
    await service.disconnect();
    expect(service.getSnapshot().models).toEqual([]);
    expect(service.getSnapshot().draftPrompt).toBe("");
    expect(service.isReady()).toBe(false);
  });

  it("取消中止尚未提交的生成并标记可重试", async () => {
    const { remote, isCancelled } = remoteStub();
    const service = createChatGptService({ remote, createRequestId: () => "req-4" });
    await service.refresh();
    service.setTarget({ canvasId: "cv", nodeId: "n1", mode: "model3d" });
    service.generate({ model: "gpt-5", prompt: "x" });
    service.cancel();
    expect(isCancelled()).toBe(true);
    expect(service.getSnapshot().run).toMatchObject({ phase: "failed", message: "已取消", retryable: true });
  });
});
