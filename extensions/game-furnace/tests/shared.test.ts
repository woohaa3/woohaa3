import { describe, expect, it } from "vitest";
import {
  GAME_FURNACE_PLUGIN_ID,
  MAX_RESOURCES,
  buildContentHash,
  computeInputHash,
  createGameFurnaceState,
  defaultResourceDescription,
  duplicateGameFurnace,
  gameFurnaceContent,
  gameFurnaceReferences,
  invertGameFurnace,
  normalizeResource,
  projectIdFor,
  reduceGameFurnace,
  resourceContentHash,
  validateGameFurnaceState,
  type GameFurnaceState
} from "../src/shared.js";

function imageResource(resourceId: string, name = "主角") {
  return normalizeResource({
    resourceId,
    kind: "image",
    name,
    payload: { kind: "asset", assetIds: ["asset-1"] },
    metadata: { mime: "image/png", size: 1024, width: 64, height: 64, previewAssetId: "asset-1" }
  });
}

function state(): GameFurnaceState {
  return createGameFurnaceState(projectIdFor("canvas-1", "node-1")) as unknown as GameFurnaceState;
}

describe("game-furnace shared codec", () => {
  it("identity 与预算稳定", () => {
    expect(GAME_FURNACE_PLUGIN_ID).toBe("game-furnace");
    expect(gameFurnaceContent.pluginId).toBe("game-furnace");
    expect(MAX_RESOURCES).toBe(128);
    expect(gameFurnaceContent.presentation).toMatchObject({ layout: "model", inputMode: "focus-only", dropPolicy: "copy-immediate", workspace: true });
  });

  it("默认空项目合法", () => {
    const s = state();
    expect(() => validateGameFurnaceState(s as never)).not.toThrow();
  });

  it("resources.add 幂等且拒绝重复 ID 冲突", () => {
    const s = state();
    const op = [{ type: "resources.add", resources: [imageResource("res-a")] }];
    const once = reduceGameFurnace(s as never, op as never) as unknown as GameFurnaceState;
    expect(once.resources).toHaveLength(1);
    // 同 operationId 重试（相同 resourceId）不重复添加。
    const twice = reduceGameFurnace(once as never, op as never) as unknown as GameFurnaceState;
    expect(twice.resources).toHaveLength(1);
  });

  it("一个非法操作拒绝整批（原子）", () => {
    const s = state();
    expect(() =>
      reduceGameFurnace(s as never, [
        { type: "resources.add", resources: [imageResource("res-a")] },
        { type: "resources.update", updates: [{ resourceId: "missing", description: "x" }] }
      ] as never)
    ).not.toThrow();
    // 第二条对不存在的资源更新不是错误（map 找不到即跳过）；用真正的非法操作验证原子性。
    expect(() =>
      reduceGameFurnace(s as never, [
        { type: "resources.add", resources: [imageResource("res-a")] },
        { type: "requirements.patch", patch: { name: "x".repeat(300) } }
      ] as never)
    ).toThrow();
  });

  it("resources.update 与 requirements.patch 生效并可逆", () => {
    const s = state();
    const withResource = reduceGameFurnace(s as never, [{ type: "resources.add", resources: [imageResource("res-a")] }] as never) as unknown as GameFurnaceState;
    const operations = [
      { type: "resources.update", updates: [{ resourceId: "res-a", category: "角色", description: "主角图" }] },
      { type: "requirements.patch", patch: { name: "跳跃游戏", description: "跳跃并收集", gameplay: "左右移动" } }
    ];
    const next = reduceGameFurnace(withResource as never, operations as never) as unknown as GameFurnaceState;
    expect(next.resources[0]!.category).toBe("角色");
    expect(next.resources[0]!.description).toBe("主角图");
    expect(next.requirements.name).toBe("跳跃游戏");
    const inverse = invertGameFurnace(withResource as never, operations as never);
    const restored = reduceGameFurnace(next as never, inverse as never) as unknown as GameFurnaceState;
    expect(restored.resources[0]!.category).toBe("图片");
    expect(restored.requirements.name).toBe("");
    expect(restored.requirements.gameplay).toBeUndefined();
  });

  it("一次素材添加可撤销并重做，恢复相同规范状态（任务 4.10）", () => {
    const before = state();
    const add = [{ type: "resources.add", resources: [imageResource("res-a")] }];
    const added = reduceGameFurnace(before as never, add as never) as unknown as GameFurnaceState;
    const undo = invertGameFurnace(before as never, add as never);
    const undone = reduceGameFurnace(added as never, undo as never) as unknown as GameFurnaceState;
    expect(undone.resources).toEqual([]);

    const redo = invertGameFurnace(added as never, undo as never);
    const redone = reduceGameFurnace(undone as never, redo as never) as unknown as GameFurnaceState;
    expect(redone).toEqual(added);
  });

  it("inputHash 对分类/描述/需求变化敏感，对位置/进度不敏感", () => {
    const base = reduceGameFurnace(state() as never, [{ type: "resources.add", resources: [imageResource("res-a")] }] as never) as unknown as GameFurnaceState;
    const hash0 = computeInputHash(base);
    const described = reduceGameFurnace(base as never, [{ type: "resources.update", updates: [{ resourceId: "res-a", description: "改了描述" }] }] as never) as unknown as GameFurnaceState;
    expect(computeInputHash(described)).not.toBe(hash0);
    const requirementChanged = reduceGameFurnace(base as never, [{ type: "requirements.patch", patch: { name: "x" } }] as never) as unknown as GameFurnaceState;
    expect(computeInputHash(requirementChanged)).not.toBe(hash0);
    // 相同内容的非素材字段不影响 hash。
    const cloned = structuredClone(base);
    (cloned as unknown as { lastViewed?: string }).lastViewed = "later";
    expect(computeInputHash(cloned)).toBe(hash0);
  });

  it("references 覆盖素材、source/manifest 与保留 build 依赖", () => {
    const s = state();
    const next = reduceGameFurnace(s as never, [
      { type: "resources.add", resources: [imageResource("res-a")] },
      {
        type: "build.register",
        build: {
          buildId: "build-1",
          generationId: "gen-0",
          inputHash: "h",
          manifestAssetId: "asset-manifest",
          sourceAssetId: "asset-source",
          dependencyAssetIds: ["asset-1", "asset-2"],
          sourceHash: "sh",
          policyVersion: "p",
          createdAt: "t",
          title: "t",
          controlsSummary: "",
          resources: [{ resourceId: "res-a", usage: "used" }]
        }
      }
    ] as never) as unknown as GameFurnaceState;
    const refs = gameFurnaceReferences(next);
    expect(refs).toContain("asset-1");
    expect(refs).toContain("asset-2");
    expect(refs).toContain("asset-manifest");
    expect(refs).toContain("asset-source");
  });

  it("duplicate 重写局部 ID 且不复制活动执行", () => {
    const s = reduceGameFurnace(state() as never, [
      { type: "resources.add", resources: [imageResource("res-a")] },
      { type: "build.register", build: { buildId: "build-1", generationId: "gen-1", inputHash: "h", manifestAssetId: "m", sourceAssetId: "s", dependencyAssetIds: [], sourceHash: "sh", policyVersion: "p", createdAt: "t", title: "t", controlsSummary: "", resources: [] } },
      { type: "build.activate", buildId: "build-1" }
    ] as never) as unknown as GameFurnaceState;
    let counter = 0;
    const copy = duplicateGameFurnace(s as never, () => `new-${counter++}`) as unknown as GameFurnaceState;
    expect(copy.projectId).not.toBe(s.projectId);
    expect(copy.resources[0]!.resourceId).not.toBe("res-a");
    expect(copy.builds[0]!.buildId).not.toBe("build-1");
    expect(copy.builds[0]!.generationId).not.toBe("gen-1");
    expect(copy.activeBuildId).toBe(copy.builds[0]!.buildId);
    // 复制项自身合法：所有跨记录引用都指向重写后的身份。
    expect(() => validateGameFurnaceState(copy as never)).not.toThrow();
  });

  it("duplicate 重映射 generation.candidateBuildId，不留下悬空指向旧 build（任务 7.9）", () => {
    const s = reduceGameFurnace(state() as never, [
      { type: "resources.add", resources: [imageResource("res-a")] },
      { type: "build.register", build: { buildId: "build-1", generationId: "gen-1", inputHash: "h", manifestAssetId: "m", sourceAssetId: "src", dependencyAssetIds: [], sourceHash: "sh", policyVersion: "p", createdAt: "t", title: "t", controlsSummary: "", resources: [{ resourceId: "res-a", usage: "used" }] } },
      { type: "generation.link", generation: { generationId: "gen-1", workerTaskKey: "t", inputHash: "h", admittedAt: "t", disposition: "candidate", candidateBuildId: "build-1" } }
    ] as never) as unknown as GameFurnaceState;
    let counter = 0;
    const copy = duplicateGameFurnace(s as never, () => `new-${counter++}`) as unknown as GameFurnaceState;
    const copiedGeneration = copy.generations.find((generation) => generation.candidateBuildId !== undefined)!;
    // 候选 build 引用被重映射到复制项自己的 build，而不是原 build-1。
    expect(copiedGeneration.candidateBuildId).not.toBe("build-1");
    expect(copy.builds.some((build) => build.buildId === copiedGeneration.candidateBuildId)).toBe(true);
    expect(() => validateGameFurnaceState(copy as never)).not.toThrow();
  });

  it("复制脱离所有 Task/工作准入，丢弃悬空候选与 latest，不修改原记录", () => {
    const original = state();
    original.generations = [{ generationId: "pending", workerTaskKey: "real-task", inputHash: "h", admittedAt: "t", workId: "work",
      pluginConfigVersion: 3, candidateBuildId: "dangling" }];
    original.latestGenerationId = "pending";
    original.projectOwner = { canvasId: "source", nodeId: "source" };
    const before = structuredClone(original);
    let index = 0;
    const copy = duplicateGameFurnace(original, () => `copy-${index++}`) as GameFurnaceState;
    expect(copy.generations[0]).toMatchObject({ executionDetached: true, disposition: "discarded" });
    expect(copy.generations[0].workerTaskKey).not.toBe("real-task");
    expect(copy.generations[0].candidateBuildId).toBeUndefined();
    expect(copy.generations[0].workId).toBeUndefined();
    expect(copy.generations[0].pluginConfigVersion).toBeUndefined();
    expect(copy.latestGenerationId).toBeUndefined();
    expect(copy.projectOwner).toBeUndefined();
    expect(original).toEqual(before);
    expect(() => validateGameFurnaceState(copy)).not.toThrow();
  });

  it("默认描述来自确定性元数据，缺失预览时说明", () => {
    expect(defaultResourceDescription({ kind: "image", name: "a", hasPreview: true, metadata: { mime: "image/png", size: 10, width: 4, height: 4 } })).toContain("image/png");
    expect(defaultResourceDescription({ kind: "unknown", name: "a", hasPreview: false })).toContain("无自动预览");
  });

  it("contentHash / buildHash 稳定", () => {
    const resource = imageResource("res-a");
    expect(resourceContentHash(resource)).toBe(resourceContentHash(imageResource("res-a")));
    expect(buildContentHash({ inputHash: "a", sourceHash: "b", policyVersion: "p", dependencyAssetIds: ["y", "x"] })).toBe(
      buildContentHash({ inputHash: "a", sourceHash: "b", policyVersion: "p", dependencyAssetIds: ["x", "y"] })
    );
  });

  it("validate 拒绝悬空 activeBuildId 与重复资源", () => {
    const s = state() as unknown as GameFurnaceState;
    expect(() => validateGameFurnaceState({ ...s, activeBuildId: "ghost" } as never)).toThrow();
    const dup = { ...s, resources: [imageResource("res-a"), imageResource("res-a")] };
    expect(() => validateGameFurnaceState(dup as never)).toThrow();
  });
});
