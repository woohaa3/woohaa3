/**
 * GLB 文件模型引用与来源判别回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 1.2 / 4.1）。
 *
 * 权威来源是节点数据的**判别字段**：`modelSourceKind="glb"` + `modelAssetId` 与脚本字段互斥；
 * 内容身份用独立前缀哈希，避免与脚本模型 hash 碰撞。
 */
import { describe, expect, it } from "vitest";
import {
  decodeGlbModelReference,
  glbModelContentHash,
  glbModelSourceHash,
  isGlbModelNodeData,
  normalizeGlbModelReference,
  readGlbModelAssetId
} from "../model-definition.js";
import { decodeModel3DNodeData, scriptModel3DNodeData } from "../canvas-node-model.js";

const ASSET_ID = `asset-upload-${"a".repeat(64)}`;

function glbNodeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "模型",
    modelSourceKind: "glb",
    modelAssetId: ASSET_ID,
    modelContentVersion: { revision: 1, sourceHash: glbModelSourceHash(ASSET_ID), contentHash: "h" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    ...overrides
  };
}

describe("GLB 文件模型来源判别", () => {
  it("识别来源与资产 id，脚本模型返回 null", () => {
    expect(isGlbModelNodeData(glbNodeData())).toBe(true);
    expect(readGlbModelAssetId(glbNodeData())).toBe(ASSET_ID);
    expect(isGlbModelNodeData({ modelScript: "" })).toBe(false);
    expect(readGlbModelAssetId({ modelAssetId: "" })).toBeNull();
    expect(readGlbModelAssetId({ modelAssetId: "x".repeat(400) })).toBeNull();
  });

  it("与脚本字段混源时整条拒绝（含空串脚本）", () => {
    for (const field of ["modelScript", "modelScriptLanguage", "modelScriptVersion"] as const) {
      const decoded = decodeGlbModelReference(glbNodeData({ [field]: "" }));
      expect(decoded.ok).toBe(false);
    }
    // 状态字段不是来源，允许存在（渲染结果上报写入）。
    expect(decodeGlbModelReference(glbNodeData({ modelScriptStatus: "ok" })).ok).toBe(true);
  });

  it("decodeModel3DNodeData 返回判别联合，脚本读取帮助函数拒绝文件模型", () => {
    const decoded = decodeModel3DNodeData(glbNodeData());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.source).toBe("glb");
    expect(scriptModel3DNodeData(glbNodeData())).toBeNull();

    const scriptData = {
      modelScript: "scene.box({});",
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    };
    const script = decodeModel3DNodeData(scriptData);
    expect(script.ok && script.value.source).toBe("script");
    expect(scriptModel3DNodeData(scriptData)?.model.modelScript).toBe("scene.box({});");
  });

  it("未知来源标记不被当作脚本模型", () => {
    const decoded = decodeModel3DNodeData({
      modelSourceKind: "gltf",
      modelScript: "scene.box({});"
    });
    expect(decoded.ok).toBe(false);
  });

  it("只有资产引用而缺少来源标记时不被当作脚本模型", () => {
    const decoded = decodeModel3DNodeData({
      modelAssetId: ASSET_ID,
      modelScript: "scene.box({});",
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }
    });
    expect(decoded.ok).toBe(false);
  });

  it("内容身份哈希与脚本 hash 空间隔离，placement 参与内容 hash", () => {
    const sourceHash = glbModelSourceHash(ASSET_ID);
    const contentHash = glbModelContentHash({
      assetId: ASSET_ID,
      placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    });
    expect(sourceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash).not.toBe(sourceHash);
    const moved = glbModelContentHash({
      assetId: ASSET_ID,
      placement: { offset: { x: 100, y: 0, z: 0 }, scale: 1, yaw: 0 }
    });
    expect(moved).not.toBe(contentHash);
  });

  it("归一化按实际内容推进 revision，同样内容不重复推进", () => {
    const first = normalizeGlbModelReference({ assetId: ASSET_ID });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.contentVersion).toMatchObject({ revision: 1, sourceHash: glbModelSourceHash(ASSET_ID) });

    const same = normalizeGlbModelReference({ assetId: ASSET_ID, previous: first.value.contentVersion });
    expect(same.ok && same.value.contentVersion.revision).toBe(1);

    const moved = normalizeGlbModelReference({
      assetId: ASSET_ID,
      placement: { offset: { x: 10, y: 0, z: 0 } },
      previous: first.value.contentVersion
    });
    expect(moved.ok && moved.value.contentVersion.revision).toBe(2);
    expect(moved.ok && moved.value.contentVersion.sourceHash).toBe(glbModelSourceHash(ASSET_ID));

    const switched = normalizeGlbModelReference({ assetId: `asset-upload-${"b".repeat(64)}`, previous: first.value.contentVersion });
    expect(switched.ok && switched.value.contentVersion.revision).toBe(2);
    expect(switched.ok && switched.value.contentVersion.sourceHash).toBe(glbModelSourceHash(`asset-upload-${"b".repeat(64)}`));
  });

  it("非法资产 id 与 placement 被拒绝", () => {
    expect(normalizeGlbModelReference({ assetId: "" }).ok).toBe(false);
    expect(normalizeGlbModelReference({ assetId: ASSET_ID, placement: { scale: 0 } }).ok).toBe(false);
  });
});
