/**
 * 游戏炼丹炉工作区/关联/远端客户端纯逻辑测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 5.5/5.6/5.7）。
 *
 * 覆盖：节点关联读写与 patch、需求草稿合并与脏字段、保存规划、工作区视图与生成阶段、
 * handler 路径与远端客户端（用注入的 fake transport，不做真实网络）。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationTransportJsonResult, ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import { createGameFurnaceState } from "../src/shared.js";
import type { GameFurnaceState } from "../src/shared.js";
import {
  gameFurnaceAssociationPatch,
  hasOpenableProject,
  isGameFurnaceNode,
  readGameFurnaceAssociation
} from "../src/frontend/associations.js";
import {
  createGameFurnaceRemote,
  handlerPath,
  remoteFailureMessage
} from "../src/frontend/remote.js";
import {
  dirtyRequirementFields,
  generationPhase,
  mergedRequirements,
  phaseLabel,
  planSaveState,
  workspaceView
} from "../src/frontend/workspace-session.js";
import {
  clearResourceDraft,
  dirtyResourceFields,
  dirtyResourceIds,
  mergedResource,
  planResourceUpdate,
  resourceConflicts
} from "../src/frontend/resource-draft.js";
import { normalizeResource, type GameResource } from "../src/shared.js";

describe("节点项目关联（任务 5.x）", () => {
  it("读取关联：仅接受非空字符串，忽略非法字段", () => {
    expect(readGameFurnaceAssociation(undefined)).toEqual({});
    expect(readGameFurnaceAssociation({ projectStorageKey: "k", inputHash: "h", activeBuildId: 3 } as never)).toEqual({
      projectStorageKey: "k",
      inputHash: "h"
    });
    expect(hasOpenableProject({ projectStorageKey: "k" })).toBe(true);
    expect(hasOpenableProject({})).toBe(false);
  });

  it("严格业务身份：composite-asset + 本扩展 discriminator 才算炼丹炉（change: 2026-10-11-extract-film-set-extension）", () => {
    const canvas = {
      document: { nodes: [
        { id: "gf", type: "composite-asset" },
        { id: "fs", type: "composite-asset" },
        { id: "m", type: "model3d" }
      ] },
      nodeData: { gf: { extensionId: "game-furnace" }, fs: { extensionId: "film-set" }, m: { extensionId: "game-furnace" } }
    };
    expect(isGameFurnaceNode(canvas, "gf")).toBe(true);
    // 同 type 的另一业务不误判为炼丹炉；普通 model3d 也不是。
    expect(isGameFurnaceNode(canvas, "fs")).toBe(false);
    expect(isGameFurnaceNode(canvas, "m")).toBe(false);
    // 缺失 discriminator 不猜；缺失画布/节点不抛错。
    expect(isGameFurnaceNode({ document: { nodes: [{ id: "x", type: "composite-asset" }] }, nodeData: {} }, "x")).toBe(false);
    expect(isGameFurnaceNode(canvas, "missing")).toBe(false);
    expect(isGameFurnaceNode(null, "gf")).toBe(false);
  });

  it("patch 保留通用字段（modelScript）并只覆盖提供关联字段", () => {
    const data = { title: "炉", modelScript: "scene.group({id:'g'});", projectStorageKey: "old" };
    const patch = gameFurnaceAssociationPatch(data, { projectStorageKey: "new", inputHash: "h" });
    expect(patch.modelScript).toBe(data.modelScript);
    expect(patch.projectStorageKey).toBe("new");
    expect(patch.inputHash).toBe("h");
    // null 显式清除。
    const cleared = gameFurnaceAssociationPatch(data, { projectStorageKey: null });
    expect("projectStorageKey" in cleared).toBe(false);
    expect(cleared.modelScript).toBe(data.modelScript);
  });
});

describe("工作区需求草稿合并（任务 5.5/5.6）", () => {
  const base = { name: "旧名", description: "旧描述" } as const;

  it("草稿优先；空串清除可选字段", () => {
    expect(mergedRequirements({ ...base, gameplay: "跳" }, { name: "新名", gameplay: "" })).toEqual({
      name: "新名",
      description: "旧描述"
    });
  });

  it("脏字段只报告真实变化（未编辑键不算脏）", () => {
    expect(dirtyRequirementFields(base, { name: "新名" })).toEqual(["name"]);
    expect(dirtyRequirementFields(base, { name: "旧名" })).toEqual([]);
    expect(dirtyRequirementFields({ ...base, gameplay: "跳" }, { gameplay: "" })).toEqual(["gameplay"]);
  });

  it("保存规划：合并需求写入状态，无状态时返回 null", () => {
    const state = createGameFurnaceState("p1");
    const saved = planSaveState(state, { name: "新", description: "描述" });
    expect(saved).not.toBeNull();
    expect((saved as { requirements: { name: string } }).requirements.name).toBe("新");
    expect(planSaveState(null, { name: "x", description: "y" })).toBeNull();
  });

  it("视图：名称/描述必填才可生成；脏字段与保存状态可见", () => {
    const state = createGameFurnaceState("p1");
    expect(workspaceView({ state, draft: {}, saved: false }).canGenerate).toBe(false);
    const view = workspaceView({ state, draft: { name: "游戏", description: "描述" }, saved: true });
    expect(view.canGenerate).toBe(true);
    expect(view.dirtyFields).toEqual(["name", "description"]);
    expect(view.saved).toBe(false);
  });

  it("生成阶段：来自 generation disposition，不引入第二事实源", () => {
    const state = createGameFurnaceState("p1");
    const withGeneration = {
      ...state,
      latestGenerationId: "g1",
      generations: [{ generationId: "g1", workerTaskKey: "w", inputHash: "h", admittedAt: "t", disposition: "candidate" }]
    } as unknown as GameFurnaceState;
    expect(generationPhase(workspaceView({ state: withGeneration, draft: {}, saved: true }))).toBe("running");
    const active = {
      ...withGeneration,
      generations: [{ ...(withGeneration.generations[0]!), disposition: "active" }]
    } as GameFurnaceState;
    expect(generationPhase(workspaceView({ state: active, draft: {}, saved: true }))).toBe("succeeded");
    expect(generationPhase(workspaceView({ state, draft: {}, saved: false }))).toBe("idle");
  });

  it("真实阶段 label 覆盖 queued/running/validating/storing/终态与未知连接（任务 6.8）", () => {
    expect(phaseLabel("queued")).toBe("排队中");
    expect(phaseLabel("running")).toBe("生成中");
    expect(phaseLabel("executing")).toBe("生成中");
    expect(phaseLabel("validating")).toBe("校验结果中");
    expect(phaseLabel("storing")).toBe("保存构建中");
    expect(phaseLabel("succeeded")).toBe("已有可用版本");
    expect(phaseLabel("failed")).toBe("生成失败");
    expect(phaseLabel("cancelled")).toBe("已取消");
    // 未知/断连阶段不编造进度。
    expect(phaseLabel("weird")).toBe("状态暂不可确认");
    expect(phaseLabel("unknown")).toBe("状态暂不可确认");
  });
});

describe("素材字段草稿按 ID 合并（任务 5.4/5.5）", () => {
  const resource = (resourceId: string, name = "主角", category = "图片", description = "image/png · 10 字节"): GameResource =>
    normalizeResource({ resourceId, kind: "image", name, category, description, payload: { kind: "asset", assetIds: [`asset-${resourceId}`] } });

  it("草稿优先呈现；未编辑字段保留权威值", () => {
    const base = resource("res-a");
    expect(mergedResource(base, undefined)).toBe(base);
    expect(mergedResource(base, { name: { value: "新名", base: "主角" } })).toMatchObject({ name: "新名", category: "图片", description: "image/png · 10 字节" });
  });

  it("脏字段只报告真正变化的字段", () => {
    const base = resource("res-a");
    expect(dirtyResourceFields(base, { name: { value: "主角", base: "主角" } })).toEqual([]);
    expect(dirtyResourceFields(base, { name: { value: "新名", base: "主角" }, description: { value: "新描述", base: "image/png · 10 字节" } })).toEqual(["name", "description"]);
    expect(dirtyResourceFields(base, undefined)).toEqual([]);
  });

  it("远端新增素材或重渲染不清空既有草稿：脏 ID 按稳定顺序、只含真正变化项（任务 5.5）", () => {
    const resources = [resource("res-a"), resource("res-b"), resource("res-c")];
    const draft = { "res-b": { description: { value: "新描述", base: "image/png · 10 字节" } } };
    const withNew = [...resources, resource("res-d")];
    expect(dirtyResourceIds(withNew, draft)).toEqual(["res-b"]);
  });

  it("逐字段提交：只下发变化字段，未编辑项不整体覆盖；无变化返回 null", () => {
    const resources = [resource("res-a"), resource("res-b")];
    const planned = planResourceUpdate(resources, { "res-b": { name: { value: "新名", base: "主角" }, description: { value: "新描述", base: "image/png · 10 字节" } } });
    expect(planned).toEqual({ ok: true, operation: { type: "resources.update", updates: [{ resourceId: "res-b", name: "新名", description: "新描述" }] } });
    expect(planResourceUpdate(resources, { "res-a": { name: { value: "主角", base: "主角" } } })).toBeNull();
  });

  it("同字段冲突可诊断：权威值偏离编辑基线时拒绝提交整批，不静默覆盖（任务 5.5）", () => {
    // 用户在 res-a 编辑名称；期间远端把名称改成「别的名字」。
    const resources = [resource("res-a", "别的名字")];
    const draft = { "res-a": { name: { value: "我的名字", base: "主角" } } };
    const planned = planResourceUpdate(resources, draft);
    expect(planned).toEqual({ ok: false, conflicts: [{ resourceId: "res-a", fields: ["name"] }] });
    expect(resourceConflicts(resources, draft)).toEqual([{ resourceId: "res-a", fields: ["name"] }]);
    // 权威值仍等于基线时不算冲突。
    expect(resourceConflicts([resource("res-a", "主角")], draft)).toEqual([]);
  });

  it("提交成功后按 ID 清除草稿，保留其它素材的编辑", () => {
    const draft = { "res-a": { name: { value: "a", base: "x" } }, "res-b": { name: { value: "b", base: "y" } } };
    expect(clearResourceDraft(draft, ["res-a"])).toEqual({ "res-b": { name: { value: "b", base: "y" } } });
  });
});

// ---------------------------------------------------------------------------
// 远端客户端（用注入 fake transport）
// ---------------------------------------------------------------------------

function fakeTransport(handler: (path: string, body: unknown) => ApplicationTransportJsonResult): { transport: ApplicationRemoteTransport; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  return {
    calls,
    transport: {
      async request(input) {
        calls.push({ path: input.path, body: input.body });
        return handler(input.path, input.body);
      },
      stream() {
        return { cancel: () => undefined };
      }
    } as ApplicationRemoteTransport
  };
}

describe("后端 handler 客户端（任务 5.x/6.x）", () => {
  it("handler 路径为受控 owner-scoped 前缀", () => {
    expect(handlerPath("game-furnace/project-save")).toBe("/api/extensions/game-furnace/handlers/game-furnace/project-save");
  });

  it("saveProject 成功解析 projectStorageKey/inputHash；畸形响应拒绝", async () => {
    const ok = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "k", inputHash: "h" } }));
    const remote = createGameFurnaceRemote({ transport: ok.transport });
    const result = await remote.saveProject({ canvasId: "c", nodeId: "n", state: createGameFurnaceState("p") as unknown as GameFurnaceState });
    expect(result).toEqual({ ok: true, value: { projectStorageKey: "k", inputHash: "h" } });
    expect(ok.calls[0]!.path).toBe(handlerPath("game-furnace/project-save"));

    const bad = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true } }));
    expect(await createGameFurnaceRemote({ transport: bad.transport }).saveProject({ canvasId: "c", nodeId: "n", state: createGameFurnaceState("p") as unknown as GameFurnaceState }))
      .toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("保存采用后端转存后的规范项目，拒绝畸形状态", async () => {
    const state = createGameFurnaceState("p") as unknown as GameFurnaceState;
    const ok = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "k", inputHash: "h", state } }));
    expect(await createGameFurnaceRemote({ transport: ok.transport }).saveProject({ canvasId: "c", nodeId: "n", state }))
      .toEqual({ ok: true, value: { projectStorageKey: "k", inputHash: "h", state } });
    const bad = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "k", inputHash: "h", state: {} } }));
    expect(await createGameFurnaceRemote({ transport: bad.transport }).saveProject({ canvasId: "c", nodeId: "n", state }))
      .toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("openProject 校验合法 state；传输失败映射稳定错误码", async () => {
    const state = createGameFurnaceState("p");
    const ok = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "k", inputHash: "h", state } }));
    const opened = await createGameFurnaceRemote({ transport: ok.transport }).openProject({ canvasId: "c", nodeId: "n", projectStorageKey: "k" });
    expect(opened).toMatchObject({ ok: true, value: { projectStorageKey: "k", inputHash: "h" } });

    const fail = fakeTransport(() => ({ ok: false, code: "not-found", error: "残留内部信息" }));
    const failed = await createGameFurnaceRemote({ transport: fail.transport }).openProject({ canvasId: "c", nodeId: "n", projectStorageKey: "k" });
    expect(failed).toEqual({ ok: false, code: "not-found", message: "残留内部信息" });
    expect(remoteFailureMessage({ code: "not-found", message: "残留内部信息" })).toBe("项目不存在或已被删除");
  });

  it("activateBuild 解析 activeBuildId；畸形响应拒绝（任务 7.7）", async () => {
    const ok = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, activeBuildId: "build-2" } }));
    const client = createGameFurnaceRemote({ transport: ok.transport });
    expect(await client.activateBuild({ canvasId: "c", nodeId: "n", buildId: "build-2" })).toEqual({ ok: true, value: { ok: true, activeBuildId: "build-2" } });
    expect(ok.calls[0]!.path).toBe(handlerPath("game-furnace/activate-build"));

    const bad = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true } }));
    expect(await createGameFurnaceRemote({ transport: bad.transport }).activateBuild({ canvasId: "c", nodeId: "n", buildId: "b" }))
      .toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("collectResources 透传目标修订基线 expectedProjectStorageKey（任务 4.4）", async () => {
    const ok = fakeTransport(() => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "k2", inputHash: "h2" } }));
    const client = createGameFurnaceRemote({ transport: ok.transport });
    const result = await client.collectResources({ canvasId: "c", nodeId: "n", operations: [], expectedProjectStorageKey: "k1" });
    expect(result).toEqual({ ok: true, value: { projectStorageKey: "k2", inputHash: "h2" } });
    expect(ok.calls[0]!.body).toMatchObject({ canvasId: "c", nodeId: "n", expectedProjectStorageKey: "k1" });
  });
});
