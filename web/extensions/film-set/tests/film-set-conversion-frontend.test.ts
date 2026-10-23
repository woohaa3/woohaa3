/**
 * 「转为片场」前端纯逻辑 + 控制器回归
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.4–3.9）。
 *
 * 非渲染检查：可用性门禁（写权限独立于下载可读取）、状态映射、直连开始规则、模型摘要、
 * 身份固定与控制器幂等（同一 requestId、Escape 草稿不写回、retry 复用同一身份）。
 */
import { describe, expect, it, vi } from "vitest";
import { defaultFilmSetConversionPrompt } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas, createModel3DNodeData, filmSetConversionNodeTaskStatus, model3DNodeDataFields, readFilmSetConversionNodeStatus, type FilmSetConversionModelCandidate, type ServerCanvas } from "@woohaa3/contracts";
import { resolveFilmSetConversionAvailability, filmSetConversionNeedsSettings } from "../src/authoring/browser/film-set-conversion/view.js";
import { resolveConversionNodeStatuses } from "../src/authoring/browser/film-set-conversion/presentation.js";
import {
  describeFilmSetConversionFailure,
  presentFilmSetConversionStatus,
  resolveFilmSetConversionDirectStart,
  resolveFilmSetConversionPreferredModelKey,
  summarizeFilmSetConversionModel
} from "../src/authoring/browser/film-set-conversion/presentation.js";
import { createFilmSetConversionIdentity, buildFilmSetConversionRequest } from "../src/authoring/browser/film-set-conversion/client.js";
import { createFilmSetConversionController } from "../src/authoring/browser/film-set-conversion/controller.js";
import { createFilmSetConversionPreferenceStore } from "../src/authoring/browser/film-set-conversion/preference.js";
import type { FilmSetConversionClient } from "../src/authoring/browser/film-set-conversion/client.js";

const NOW = "2026-10-13T00:00:00.000Z";

function canvasWith(nodes: ServerCanvas["document"]["nodes"], nodeData: ServerCanvas["nodeData"], assets: ServerCanvas["assets"]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  return { ...base, document: { ...base.document, nodes }, nodeData, assets };
}

const imageAsset = {
  id: "asset-image", title: "参考图", mediaKind: "image" as const, source: "uploaded" as const, status: "ready" as const,
  createdAt: NOW, url: "/api/media/a", metadata: { storageKey: "sha256-a", checksum: "a".repeat(64), contentType: "image/png", size: 4 }
};

describe("转换可用性门禁（任务 3.4/3.9）", () => {
  it("图片/视频就绪且可写时可转换", () => {
    const canvas = canvasWith(
      [{ id: "img", type: "image", position: { x: 0, y: 0 } }, { id: "vid", type: "video", position: { x: 0, y: 0 } }],
      { img: { outputAssetId: "asset-image" }, vid: { outputAssetId: "asset-video" } },
      [imageAsset, { ...imageAsset, id: "asset-video", mediaKind: "video", metadata: { ...imageAsset.metadata, contentType: "video/mp4" } }]
    );
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "img", nodeType: "image", writable: true })).toEqual({ available: true });
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "vid", nodeType: "video", writable: true })).toEqual({ available: true });
  });

  it("只读会话禁用转换（写门禁独立于下载的可读取门禁）", () => {
    const canvas = canvasWith([{ id: "img", type: "image", position: { x: 0, y: 0 } }], { img: { outputAssetId: "asset-image" } }, [imageAsset]);
    const result = resolveFilmSetConversionAvailability({ canvas, nodeId: "img", nodeType: "image", writable: false });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("不可写");
  });

  it("资源未就绪禁用；非来源类型禁用；模型不完整禁用", () => {
    const canvas = canvasWith(
      [{ id: "img", type: "image", position: { x: 0, y: 0 } }, { id: "txt", type: "text", position: { x: 0, y: 0 } }, { id: "m", type: "model3d", position: { x: 0, y: 0 } }],
      { img: { outputAssetId: "missing" }, txt: {}, m: {} },
      [imageAsset]
    );
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "img", nodeType: "image", writable: true }).available).toBe(false);
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "txt", nodeType: "text", writable: true }).available).toBe(false);
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "m", nodeType: "model3d", writable: true }).available).toBe(false);
  });

  it("3D 需要完整模型定义", () => {
    const canvas = canvasWith(
      [{ id: "m", type: "model3d", position: { x: 0, y: 0 } }],
      { m: model3DNodeDataFields(createModel3DNodeData({ title: "模型", model: { modelScript: "scene.box({ id: 'a' });", modelScriptVersion: "woohaa-model-js-v2" } })) } as ServerCanvas["nodeData"],
      []
    );
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: "m", nodeType: "model3d", writable: true })).toEqual({ available: true });
  });

  it("图片/视频使用创建弹窗，3D 直接复制", () => {
    expect(filmSetConversionNeedsSettings("image")).toBe(true);
    expect(filmSetConversionNeedsSettings("video")).toBe(true);
    expect(filmSetConversionNeedsSettings("model3d")).toBe(false);
  });
});

describe("状态映射（任务 3.8）", () => {
  it("画布拒绝写入时保留具体原因，不误报助手登录过期", () => {
    const view = presentFilmSetConversionStatus({ status: "failed", requestId: "r", sourceNodeId: "s", code: "unauthorized", message: "画布写权限已失效，转换已停止", attempt: 1, retryable: false });
    expect(view.label).toBe("无法继续创建片场");
    expect(view.reason).toBe("画布写权限已失效，转换已停止");
    expect(view.recovery).toBe("检查画布权限或助手连接");
  });

  it("阶段来自真实步骤，running 可取消", () => {
    const view = presentFilmSetConversionStatus({ status: "running", requestId: "r", sourceNodeId: "s", step: "analyze-content" });
    expect(view.kind).toBe("running");
    expect(view.step).toBe("分析内容");
    expect(view.cancellable).toBe(true);
  });

  it("只有权威提交成功才算完成并可打开片场", () => {
    const view = presentFilmSetConversionStatus({ status: "completed", requestId: "r", sourceNodeId: "s", targetNodeId: "t", commandId: "c" });
    expect(view.kind).toBe("completed");
    expect(view.openable).toBe(true);
    expect(presentFilmSetConversionStatus(null).kind).toBe("idle");
  });

  it("unknown 先查询、失败按类别给标题并优先具体原因", () => {
    const unknown = presentFilmSetConversionStatus({ status: "unknown", requestId: "r", sourceNodeId: "s" });
    expect(unknown.needsQuery).toBe(true);
    // 结果未知仍可取消：中断/重启后的占位节点必须能脱离「进行中」才可删除。
    expect(unknown.cancellable).toBe(true);
    // 标题按错误类别区分；有具体 message 时详情显示具体原因（例如几何约束）。
    const failed = presentFilmSetConversionStatus({ status: "failed", requestId: "r", sourceNodeId: "s", code: "candidate-invalid", message: "对象 scarf 的 capsule 总高度不得小于直径", attempt: 1, retryable: true });
    expect(failed.label).toBe("片场候选未通过校验");
    expect(failed.reason).toContain("capsule 总高度不得小于直径");
    expect(failed.retryable).toBe(true);
    // 不同错误码给出不同标题（不再一律「转换失败」）。
    const vision = presentFilmSetConversionStatus({ status: "failed", requestId: "r", sourceNodeId: "s", code: "model-not-vision-capable", message: "", attempt: 1, retryable: true });
    expect(vision.label).toBe("模型不支持视觉输入");
    // message 与类别原因重复时不重复展示详情。
    const dup = presentFilmSetConversionStatus({ status: "failed", requestId: "r", sourceNodeId: "s", code: "candidate-invalid", message: "模型返回的片场候选未通过校验", attempt: 1, retryable: true });
    expect(dup.label).toBe("片场候选未通过校验");
    expect(dup.reason).toBeUndefined();
    expect(describeFilmSetConversionFailure("budget-exceeded").recovery).toContain("范围");
  });
});

describe("直连开始与模型摘要（任务 3.6/3.7）", () => {
  const model = (modelKey: string, supports: FilmSetConversionModelCandidate["supports"], isDefault = false): FilmSetConversionModelCandidate => ({
    modelKey, label: `${modelKey} 展示名`, supports, isDefault,
    capabilities: { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 8, videoInput: false, maxFrames: 8, maxDurationSeconds: 0 } }
  });

  it("显式且支持的模型直接开始", () => {
    const models = [model("p:a", ["image"]), model("p:b", ["video"])];
    expect(resolveFilmSetConversionDirectStart({ models, modelKey: "p:a", sourceKind: "image" })).toEqual({ start: true, modelKey: "p:a" });
  });

  it("显式但不支持该来源 → 打开设置，不静默换模型", () => {
    const models = [model("p:a", ["image"])];
    const decision = resolveFilmSetConversionDirectStart({ models, modelKey: "p:a", sourceKind: "video" });
    expect(decision.start).toBe(false);
  });

  it("无显式选择：唯一默认支持候选直接采用；多个候选无默认时打开设置", () => {
    expect(resolveFilmSetConversionDirectStart({ models: [model("p:a", ["image"], true)], sourceKind: "image" })).toEqual({ start: true, modelKey: "p:a" });
    const many = resolveFilmSetConversionDirectStart({ models: [model("p:a", ["image"]), model("p:b", ["image"])], sourceKind: "image" });
    expect(many.start).toBe(false);
    expect(resolveFilmSetConversionDirectStart({ models: [], sourceKind: "image" }).start).toBe(false);
  });

  it("摘要使用真实展示名；无候选返回 null", () => {
    expect(summarizeFilmSetConversionModel({ models: [model("p:a", ["image"])], sourceKind: "image" })?.label).toBe("p:a 展示名");
    expect(summarizeFilmSetConversionModel({ models: [], sourceKind: "image" })).toBeNull();
  });

  it("设置弹窗推荐默认模型：默认支持候选优先；无支持候选返回 undefined（不预置必然失败的模型）", () => {
    expect(resolveFilmSetConversionPreferredModelKey({ models: [model("p:a", ["video"]), model("p:b", ["image"], true)], sourceKind: "image" })).toBe("p:b");
    expect(resolveFilmSetConversionPreferredModelKey({ models: [model("p:a", ["image"]), model("p:b", ["image"])], sourceKind: "image" })).toBe("p:a");
    expect(resolveFilmSetConversionPreferredModelKey({ models: [model("p:a", ["video"])], sourceKind: "image" })).toBeUndefined();
    expect(resolveFilmSetConversionPreferredModelKey({ models: [], sourceKind: "image" })).toBeUndefined();
  });
});

describe("身份与请求构造（任务 3.5）", () => {
  it("固定身份 + 规范请求体（空设置省略）", () => {
    const identity = createFilmSetConversionIdentity({ sourceNodeId: "img", sourceKind: "image" });
    expect(identity.sourceNodeId).toBe("img");
    expect(identity.requestId).not.toBe(identity.targetNodeId);
    const request = buildFilmSetConversionRequest({ canvasId: "c1", identity, settings: {} });
    expect(request.requestId).toBe(identity.requestId);
    expect(request.targetNodeId).toBe(identity.targetNodeId);
    expect(request).not.toHaveProperty("settings");
  });

  it("范围与要求进入请求体，空要求被丢弃", () => {
    const identity = createFilmSetConversionIdentity({ sourceNodeId: "vid", sourceKind: "video" });
    const request = buildFilmSetConversionRequest({
      canvasId: "c1", identity, settings: { modelKey: "p:a", instruction: "   ", range: { startSeconds: 1, endSeconds: 3 } }
    });
    expect(request.settings).toEqual({ modelKey: "p:a", range: { startSeconds: 1, endSeconds: 3 } });
  });
});

describe("控制器：共享动作与请求身份（任务 3.5/3.6/3.7/3.8）", () => {
  function setup(options: { models?: readonly FilmSetConversionModelCandidate[]; writable?: boolean; statuses?: readonly string[]; submitError?: string; getCanvas?: () => ServerCanvas | null; getDataScopeId?: () => string } = {}) {
    const submitted: Array<{ requestId: string; sourceNodeId: string; settings?: unknown }> = [];
    const calls = { cancel: 0, retry: 0, query: 0, models: 0 };
    // 每次提交按序返回脚本化状态（缺省 completed）。
    const statusFor = (requestId: string, targetNodeId: string) => {
      const scripted = options.statuses?.[submitted.length - 1] ?? "completed";
      if (scripted === "running") return { status: "running" as const, requestId, sourceNodeId: "img", step: "analyze-content" as const };
      if (scripted === "unknown") return { status: "unknown" as const, requestId, sourceNodeId: "img" };
      if (scripted === "failed") return { status: "failed" as const, requestId, sourceNodeId: "img", code: "model-not-configured" as const, message: "尚未配置支持视觉输入的转换模型", attempt: 1, retryable: true };
      return { status: "completed" as const, requestId, sourceNodeId: "img", targetNodeId, commandId: "cmd" };
    };
    const client: FilmSetConversionClient = {
      models: async () => { calls.models += 1; return { ok: true, value: { models: [...(options.models ?? [])] } }; },
      submit: async (request) => {
        submitted.push({ requestId: request.requestId, sourceNodeId: request.sourceNodeId, settings: request.settings });
        if (options.submitError) return { ok: false, code: "model-not-configured", error: options.submitError };
        const status = statusFor(request.requestId, request.targetNodeId);
        return { ok: true, receipt: { ok: true, requestId: request.requestId, targetNodeId: request.targetNodeId, commandId: "cmd", duplicate: false }, status };
      },
      status: async () => { calls.query += 1; return { ok: true, value: { status: null } }; },
      cancel: async () => { calls.cancel += 1; return { ok: true, value: { status: { status: "cancelled", requestId: "r", sourceNodeId: "s" } } }; },
      retry: async ({ requestId }) => { calls.retry += 1; return { ok: true, receipt: { ok: true, requestId, targetNodeId: "t", commandId: "cmd", duplicate: false }, status: { status: "completed", requestId, sourceNodeId: "s", targetNodeId: "t", commandId: "cmd" } }; }
    };
    const preferences = createFilmSetConversionPreferenceStore({ storage: null });
    const openFilmSet = vi.fn();
    const controller = createFilmSetConversionController({
      canvasId: "c1", client, preferences, getDataScopeId: options.getDataScopeId,
      openFilmSet,
      getCanvas: options.getCanvas ?? (() => null),
      isWritable: () => options.writable ?? true
    });
    return { controller, submitted, calls, preferences, client, openFilmSet };
  }

  const supported: FilmSetConversionModelCandidate = {
    modelKey: "p:vision", label: "视觉模型", isDefault: true, supports: ["image", "video"],
    capabilities: { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 8, videoInput: true, maxFrames: 0, maxDurationSeconds: 0 } }
  };

  it("clears source drafts on identity change and ignores the former owner's late acceptance", async () => {
    let owner = "owner-a";
    const h = setup({ models: [supported], getDataScopeId: () => owner });
    let finish!: (value: Awaited<ReturnType<FilmSetConversionClient["submit"]>>) => void;
    let request!: Parameters<FilmSetConversionClient["submit"]>[0];
    h.client.submit = input => { request = input; return new Promise(resolve => { finish = resolve; }); };
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { instruction: "Private draft" } });
    const pending = h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    owner = "owner-b";
    expect(h.controller.getSnapshot().entries.size).toBe(0);
    const fresh = h.controller.getEntry("img", "image");
    expect(fresh.draft.instruction).not.toBe("Private draft");
    finish({ ok: true, receipt: { ok: true, requestId: request.requestId, targetNodeId: request.targetNodeId, commandId: "saved", duplicate: false },
      status: { status: "completed", requestId: request.requestId, sourceNodeId: "img", targetNodeId: request.targetNodeId, commandId: "saved" } });
    expect(await pending).toBe(false);
    expect(h.controller.getEntry("img", "image").status).toBeNull();
  });

  it("来源默认提示词区分图片与视频，主动清空后重开保持空草稿", () => {
    const h = setup({ models: [supported] });
    expect(h.controller.getEntry("img", "image").draft.instruction).toBe(defaultFilmSetConversionPrompt("image"));
    expect(h.controller.getEntry("vid", "video").draft.instruction).toBe(defaultFilmSetConversionPrompt("video"));
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { instruction: "" } });
    h.controller.closeSettings({ nodeId: "img", nodeType: "image" });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    expect(h.controller.getEntry("img", "image").draft.instruction).toBe("");
    expect(h.submitted).toHaveLength(0);
  });

  it("queries a lost response by the frozen request and preserves later edits", async () => {
    const h = setup({ models: [supported] });
    let frozen: Parameters<FilmSetConversionClient["submit"]>[0] | undefined;
    h.client.submit = async request => { frozen = structuredClone(request); throw new Error("response lost"); };
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:vision", instruction: "Original" } });
    expect(await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" })).toBe(false);
    expect(h.controller.getEntry("img", "image").pending).toBe(true);
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:other", instruction: "Later edit" } });
    const query = vi.fn(async ({ requestId }: { canvasId: string; requestId: string }) => ({ ok: true as const, value: {
      status: { status: "completed" as const, requestId, sourceNodeId: "img", targetNodeId: frozen!.targetNodeId, commandId: "saved" } } }));
    h.client.status = query;
    expect(await h.controller.queryCreation({ nodeId: "img" })).toBe(true);
    expect(query).toHaveBeenCalledWith({ canvasId: "c1", requestId: frozen!.requestId });
    expect(frozen!.settings?.instruction).toBe("Original");
    expect(h.controller.getEntry("img", "image").draft.instruction).toBe("Later edit");
  });
  it("有推荐模型也先打开弹窗，确认才提交", async () => {
    const h = setup({ models: [supported] });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    const entry = h.controller.getEntry("img", "image");
    expect(h.submitted).toHaveLength(0);
    expect(entry.settingsOpen).toBe(true);
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(1);
    expect(h.controller.getEntry("img", "image").identity?.requestId).toBe(h.submitted[0]!.requestId);
  });

  it("无候选打开创建弹窗且不提交（不调用随机候选）", async () => {
    const h = setup({ models: [] });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    const entry = h.controller.getEntry("img", "image");
    expect(entry.settingsOpen).toBe(true);
    expect(h.submitted).toHaveLength(0);
  });

  it("无 Dialog 回调时调用宿主的 requestSettings（横条模式唯一渲染路径）", async () => {
    const h = setup({ models: [] });
    const requestSettings = vi.fn();
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true, requestSettings });
    expect(requestSettings).toHaveBeenCalledTimes(1);
    expect(h.submitted).toHaveLength(0);
  });

  it("3D 直接提交，不解析模型也不打开设置（design D1/D3）", async () => {
    const h = setup({ models: [] });
    const requestSettings = vi.fn();
    await h.controller.activate({ nodeId: "m", nodeType: "model3d", writable: true, requestSettings });
    expect(h.submitted).toHaveLength(1);
    expect(h.calls.models).toBe(0);
    expect(requestSettings).not.toHaveBeenCalled();
    expect(h.controller.getEntry("m", "model3d").status?.status).toBe("completed");
    const status = h.controller.getEntry("m", "model3d").status;
    expect(status?.status === "completed" && status.targetNodeId).toBeTruthy();
    expect(h.openFilmSet).toHaveBeenCalledTimes(1);
    expect(h.openFilmSet).toHaveBeenCalledWith(status?.status === "completed" ? status.targetNodeId : "");
  });

  it("3D 创建失败时不定位一个不存在的片场", async () => {
    const h = setup({ submitError: "模型内容不完整" });
    await h.controller.activate({ nodeId: "m", nodeType: "model3d", writable: true });
    expect(h.openFilmSet).not.toHaveBeenCalled();
    expect(h.controller.getEntry("m", "model3d").error).toBe("模型内容不完整");
  });

  it("Escape 关闭草稿不改已保存设置", () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:other", instruction: "改了" } });
    h.controller.closeSettings({ nodeId: "img", nodeType: "image" });
    const entry = h.controller.getEntry("img", "image");
    expect(entry.saved.modelKey).toBeUndefined();
    expect(entry.draft).toEqual({ modelKey: "p:other", instruction: "改了" });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    expect(h.controller.getEntry("img", "image").draft.instruction).toBe("改了");
  });

  it("设置层开始：保存草稿并立即提交一次", async () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:vision", instruction: "保留布局" } });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.settings).toEqual({ modelKey: "p:vision", instruction: "保留布局" });
    expect(h.controller.getEntry("img", "image").saved.modelKey).toBe("p:vision");
  });

  it("打开设置预置推荐模型：未手动选择时「开始转换」也有可用模型（不再以空选择被拒）", async () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    // 候选异步到达后预置（弹窗会随控制器快照重渲染）。
    await vi.waitFor(() => expect(h.controller.getEntry("img", "image").draft.modelKey).toBe("p:vision"));
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted[0]!.settings).toEqual({ modelKey: "p:vision", instruction: defaultFilmSetConversionPrompt("image") });
  });

  it("提交前失败（无占位片场）返回 false 并保留原因，供弹窗就地显示；再次点击换新身份", async () => {
    const h = setup({ models: [supported], submitError: "尚未配置支持视觉输入的转换模型" });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    const accepted = await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(accepted).toBe(false);
    expect(h.controller.getEntry("img", "image").error).toContain("尚未配置");
    // 服务端未登记该身份：不改设置再点也必须是新 requestId，否则会命中旧请求而「没反应」。
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[0]!.requestId).not.toBe(h.submitted[1]!.requestId);
    // 占位片场已创建的任务级失败返回 true：失败呈现在目标节点上，不占用源节点弹窗。
    const failed = setup({ models: [supported], statuses: ["failed"] });
    failed.controller.openSettings({ nodeId: "img", nodeType: "image" });
    expect(await failed.controller.startFromSettings({ nodeId: "img", nodeType: "image" })).toBe(true);
    expect(failed.controller.getEntry("img", "image").error).toBeNull();
  });

  it("失败后再点「开始转换」是新的转换（新 requestId，不命中旧幂等回执）", async () => {
    const h = setup({ models: [supported], statuses: ["failed", "completed"] });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.controller.getEntry("img", "image").status?.status).toBe("failed");
    // 占位片场被用户删除后再经设置层重试：设置未变，但终态后必须换新身份，否则服务端幂等返回旧失败且不再创建占位。
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[0]!.requestId).not.toBe(h.submitted[1]!.requestId);
  });

  it("cancel/retry/query 复用同一身份", async () => {
    const h = setup({ models: [supported] });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    await h.controller.cancel({ nodeId: "img" });
    await h.controller.retry({ nodeId: "img" });
    await h.controller.query({ nodeId: "img" });
    expect(h.calls).toMatchObject({ cancel: 1, retry: 1, query: 1 });
    expect(h.controller.getEntry("img", "image").identity?.requestId).toBe(h.submitted[0]!.requestId);
  });

  it("快照订阅在发布时通知，读取稳定", async () => {
    const h = setup({ models: [supported] });
    const listener = vi.fn();
    const stop = h.controller.subscribe(listener);
    const first = h.controller.getSnapshot();
    expect(h.controller.getSnapshot()).toBe(first);
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    expect(listener).toHaveBeenCalled();
    expect(h.controller.getSnapshot()).not.toBe(first);
    stop();
  });

  it("终态后主动再点是一次新转换（每次都是新 requestId）", async () => {
    const h = setup({ models: [supported], statuses: ["completed", "completed", "completed"] });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(3);
    expect(new Set(h.submitted.map((entry) => entry.requestId)).size).toBe(3);
    expect(h.controller.getEntry("img", "image").identity?.requestId).toBe(h.submitted[2]!.requestId);
  });

  it("running and unknown targets do not lock a new creation", async () => {
    const running = setup({ models: [supported], statuses: ["running"] });
    await running.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await running.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(running.controller.getEntry("img", "image").status?.status).toBe("running");
    await running.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    expect(running.submitted).toHaveLength(1);

    const unknown = setup({ models: [supported], statuses: ["unknown"] });
    await unknown.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    await unknown.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    await unknown.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    expect(unknown.calls.query).toBe(0);
    expect(unknown.controller.getEntry("img", "image").settingsOpen).toBe(true);
    const first = unknown.submitted[0]!.requestId;
    await unknown.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(unknown.submitted[1]!.requestId).not.toBe(first);
    expect(unknown.submitted).toHaveLength(2);
  });

  it("收起面板/编辑草稿不提交；重新挂载不自动执行（刷新/切换画布/收起面板不重复执行）", async () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:vision" } });
    // 仅打开/编辑/收起：不提交、不调用上游。
    h.controller.closeSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(0);
    // 切换画布/刷新后重新挂载控制器：只读取条目，不自动重跑既有任务。
    const remount = setup({ models: [supported] });
    remount.controller.subscribe(vi.fn());
    remount.controller.getEntry("img", "image");
    remount.controller.getSnapshot();
    expect(remount.submitted).toHaveLength(0);
  });

  it("改动设置后开始：换新身份，避免同 requestId 不同输入被拒", async () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:vision", instruction: "第一次" } });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:vision", instruction: "改过" } });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[0]!.requestId).not.toBe(h.submitted[1]!.requestId);
    expect(h.submitted.map((entry) => entry.settings)).toEqual([
      { modelKey: "p:vision", instruction: "第一次" },
      { modelKey: "p:vision", instruction: "改过" }
    ]);
  });

  it("占位节点恢复动作按持久 requestId 操作（刷新后仍可用）", async () => {
    const h = setup({ models: [supported] });
    // 未激活源节点条目：直接以持久 requestId 触发目标节点上的恢复动作。
    expect((await h.controller.queryRequest({ requestId: "persisted-req" })).ok).toBe(true);
    expect((await h.controller.retryRequest({ requestId: "persisted-req" })).ok).toBe(true);
    expect((await h.controller.cancelRequest({ requestId: "persisted-req" })).ok).toBe(true);
    expect(h.calls).toMatchObject({ query: 1, retry: 1, cancel: 1 });
  });

  it("完整视频忽略旧范围草稿，跨来源只继承模型", async () => {
    const h = setup({ models: [supported] });
    h.controller.openSettings({ nodeId: "vid", nodeType: "video" });
    h.controller.setDraft({ nodeId: "vid", nodeType: "video", draft: { modelKey: supported.modelKey, instruction: "保留镜头运动", range: { startSeconds: 1, endSeconds: 3 } } });
    await h.controller.startFromSettings({ nodeId: "vid", nodeType: "video" });
    expect(h.submitted[0]!.settings).toEqual({ modelKey: supported.modelKey, instruction: "保留镜头运动" });
    expect(h.preferences.read()).toEqual({ modelKey: supported.modelKey });
    expect(h.controller.getEntry("img", "image").draft).toEqual({ modelKey: supported.modelKey, instruction: defaultFilmSetConversionPrompt("image") });
  });

  it("提交等待期间不重复请求，冻结本次提示词", async () => {
    const h = setup({ models: [supported] });
    const original = h.client.submit;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    h.client.submit = vi.fn(async request => { await pending; return original(request); });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: supported.modelKey, instruction: "第一次" } });
    const submission = h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    expect(await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" })).toBe(false);
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: supported.modelKey, instruction: "改过" } });
    finish();
    await submission;
    expect(h.client.submit).toHaveBeenCalledTimes(1);
    expect(h.submitted[0]!.settings).toEqual({ modelKey: supported.modelKey, instruction: "第一次" });
  });

  it("remounted source permits a different target while the old target runs", async () => {
    let canvas: ServerCanvas | null = null;
    const h = setup({ models: [supported], statuses: ["running"], getCanvas: () => canvas });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    await h.controller.startFromSettings({ nodeId: "img", nodeType: "image" });
    const identity = h.controller.getEntry("img", "image").identity!;
    canvas = canvasWith([{ id: identity.targetNodeId, type: "composite-asset", position: { x: 0, y: 0 } }], {
      [identity.targetNodeId]: { extensionId: "film-set", filmSetConversion: { status: "completed", requestId: identity.requestId, sourceNodeId: "img", targetNodeId: identity.targetNodeId, commandId: "c" } } as never
    }, []);
    expect(h.controller.state.statusForSource("img")?.status).toBe("completed");
    await h.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    expect(h.controller.getEntry("img", "image").settingsOpen).toBe(true);
    const running = canvasWith(canvas.document.nodes, {
      [identity.targetNodeId]: { extensionId: "film-set", filmSetConversion: { status: "running", requestId: identity.requestId, sourceNodeId: "img", step: "analyze-content" } } as never
    }, []);
    const remount = setup({ models: [supported], getCanvas: () => running });
    await remount.controller.activate({ nodeId: "img", nodeType: "image", writable: true });
    expect(remount.controller.getEntry("img", "image").settingsOpen).toBe(true);
    expect(await remount.controller.startFromSettings({ nodeId: "img", nodeType: "image" })).toBe(true);
    expect(remount.submitted).toHaveLength(1);
    expect(remount.submitted[0]!.requestId).not.toBe(identity.requestId);
  });

  it("迟到的模型目录不覆盖新选择，失败原因保留", async () => {
    const h = setup({ models: [supported] });
    let finish!: (result: Awaited<ReturnType<FilmSetConversionClient["models"]>>) => void;
    h.client.models = () => new Promise(resolve => { finish = resolve; });
    h.controller.openSettings({ nodeId: "img", nodeType: "image" });
    h.controller.setDraft({ nodeId: "img", nodeType: "image", draft: { modelKey: "p:chosen", instruction: "草稿" } });
    finish({ ok: false, code: "model-not-configured", error: "无法读取模型" });
    await vi.waitFor(() => expect(h.controller.getEntry("img", "image").modelsLoaded).toBe(true));
    expect(h.controller.getEntry("img", "image").draft.modelKey).toBe("p:chosen");
    expect(h.controller.getEntry("img", "image").error).toBe("无法读取模型");
  });
});

describe("占位节点状态读取与呈现（任务 3.8 / D4）", () => {
  function canvasWithStatus(nodeId: string, status: unknown): ServerCanvas {
    return canvasWith(
      [{ id: nodeId, type: "composite-asset", position: { x: 0, y: 0 } }],
      { [nodeId]: { extensionId: "film-set", filmSetConversion: status } as never },
      []
    );
  }

  it("从占位节点 nodeData 读取权威状态（非法整体丢弃）", () => {
    expect(readFilmSetConversionNodeStatus({ filmSetConversion: { status: "running", requestId: "r", sourceNodeId: "s", step: "generate-film-set" } }))
      .toEqual({ status: "running", requestId: "r", sourceNodeId: "s", step: "generate-film-set" });
    expect(readFilmSetConversionNodeStatus({ filmSetConversion: { status: "running", requestId: "r" } })).toBeNull();
    expect(readFilmSetConversionNodeStatus({})).toBeNull();
    expect(readFilmSetConversionNodeStatus(null)).toBeNull();
  });

  it("映射到目标节点的通用任务状态（进行中受任务边界保护）", () => {
    expect(filmSetConversionNodeTaskStatus({ status: "running", requestId: "r", sourceNodeId: "s", step: "prepare-source" })).toBe("processing");
    expect(filmSetConversionNodeTaskStatus({ status: "unknown", requestId: "r", sourceNodeId: "s" })).toBe("processing");
    expect(filmSetConversionNodeTaskStatus({ status: "completed", requestId: "r", sourceNodeId: "s", targetNodeId: "t", commandId: "c" })).toBe("successed");
    expect(filmSetConversionNodeTaskStatus({ status: "failed", requestId: "r", sourceNodeId: "s", code: "candidate-invalid", message: "x", attempt: 1, retryable: false })).toBe("failed");
    expect(filmSetConversionNodeTaskStatus({ status: "cancelled", requestId: "r", sourceNodeId: "s" })).toBe("cancelled");
  });

  it("定位带转换状态的片场节点并呈现阶段/失败/恢复", () => {
    const running = canvasWithStatus("film-1", { status: "running", requestId: "r", sourceNodeId: "s", step: "analyze-content" });
    const located = resolveConversionNodeStatuses(running)[0];
    expect(located?.nodeId).toBe("film-1");
    expect(located && presentFilmSetConversionStatus(located.status).step).toBe("分析内容");

    const failed = canvasWithStatus("film-2", { status: "failed", requestId: "r2", sourceNodeId: "s", code: "candidate-invalid", message: "x", attempt: 1, retryable: true });
    const failedLocated = resolveConversionNodeStatuses(failed)[0];
    expect(failedLocated && presentFilmSetConversionStatus(failedLocated.status).kind).toBe("failed");
    expect(failedLocated && presentFilmSetConversionStatus(failedLocated.status).retryable).toBe(true);

    expect(resolveConversionNodeStatuses(null)).toEqual([]);
    expect(resolveConversionNodeStatuses(canvasWith([{ id: "n", type: "image", position: { x: 0, y: 0 } }], { n: { outputAssetId: "a" } }, []))).toEqual([]);
  });
});
