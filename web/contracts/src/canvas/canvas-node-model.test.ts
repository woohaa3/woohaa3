/**
 * 自包含 ModelDefinition 与两类 3D 节点数据契约测试
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.1–1.5；
 *  change: 2026-10-11-extract-film-set-extension，D7/D8/D10 —— items-only）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PLACEMENT,
  decodeLocalModelPlacement,
  decodeModelDefinition,
  deriveModelContentVersion,
  modelContentHash,
  modelSourceHash,
  placementKey,
  type ModelPlacement
} from "./model-definition.js";
import {
  basedOnModel,
  compareMotionToModel,
  decodeMotionDefinition,
  hashMotionScript
} from "./motion-script.js";
import {
  decodeFilmSetNodeData,
  decodeModel3DNodeData,
  MODEL3D_NODE_TYPE,
  FILM_SET_NODE_TYPE,
  buildAnimationPlayback
} from "./canvas-node-model.js";
import { executeMotionScript } from "./motion-executor.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { createFilmSetSnapshot } from "./animation-snapshot.js";

const SCRIPT = `scene.box({ id: "torso", size: [1, 2, 0.5] });`;
const MOTION = `motion.model.rotate("torso", { speed: 0.5 });`;
const ITEM_ID = "model";

function modelNodeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const placement: ModelPlacement = DEFAULT_MODEL_PLACEMENT;
  const contentVersion = deriveModelContentVersion({
    modelScript: SCRIPT,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    placement,
    revision: 1
  });
  return {
    title: "身体",
    modelScript: SCRIPT,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: contentVersion,
    modelPlacement: placement,
    ...overrides
  };
}

/** 扁平运动定义（仍被片场 binding 复用）；不含任何节点身份字段。 */
function motionNodeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    motionScript: MOTION,
    motionScriptLanguage: "javascript",
    motionScriptVersion: "woohaa-motion-js-v1",
    motionRevision: 1,
    motionSourceHash: hashMotionScript(MOTION),
    motionBasedOnModelVersion: basedOnModel(
      deriveModelContentVersion({
        modelScript: SCRIPT,
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        placement: DEFAULT_MODEL_PLACEMENT,
        revision: 1
      })
    ),
    ...overrides
  };
}

/** items-only 片场节点 flat nodeData（model item + 单个 binding 动作）。 */
function filmSetNodeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const animation = createFilmSetSnapshot({
    title: "挥手",
    model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: MOTION,
    timeline: { duration: 4, loop: false }
  });
  return { ...canonicalFilmSetFields(animation), ...overrides };
}

/** 给默认片段写入一段相机轨道，用于验证片段独立镜头（D10）。 */
function withCameraOrbit(animation: ReturnType<typeof createFilmSetSnapshot>) {
  const orbit = cameraMotionSample();
  const clips = animation.filmSetAnimations!.clips.map(clip => ({ ...clip, cameraMotion: orbit }));
  return { ...animation, filmSetAnimations: { ...animation.filmSetAnimations!, clips } };
}

function cameraMotionSample() {
  const script = `motion.camera.tween({ id: "camera-orbit", property: "azimuth", startTime: 0, endTime: 4, from: 0, to: 1 });`;
  return {
    motionScript: script,
    motionScriptLanguage: "javascript" as const,
    motionScriptVersion: "woohaa-motion-js-v1" as const,
    revision: 1,
    sourceHash: hashMotionScript(script),
    basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" }
  };
}

describe("ModelDefinition 契约（任务 1.1）", () => {
  it("读取完整定义并按默认补齐 placement", () => {
    const decoded = decodeModelDefinition(modelNodeData({ modelPlacement: undefined }));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.modelScript).toBe(SCRIPT);
    expect(decoded.value.placement).toEqual(DEFAULT_MODEL_PLACEMENT);
    expect(decoded.value.contentVersion.revision).toBe(1);
  });

  it("未知脚本语言/版本稳定拒绝", () => {
    expect(decodeModelDefinition(modelNodeData({ modelScriptLanguage: "gdscript" })).ok).toBe(false);
    expect(decodeModelDefinition(modelNodeData({ modelScriptVersion: "woohaa-model-js-v9" })).ok).toBe(false);
  });

  it("内容标识覆盖源码、API 版本与 placement，不因来源说明或 revision 变化", () => {
    const base = {
      modelScript: SCRIPT,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      placement: DEFAULT_MODEL_PLACEMENT
    };
    const hash = modelContentHash(base);
    expect(modelContentHash({ ...base, modelScript: "scene.box({});" })).not.toBe(hash);
    expect(modelContentHash({ ...base, modelScriptVersion: "woohaa-model-js-v9" })).not.toBe(hash);
    expect(
      modelContentHash({ ...base, placement: { ...DEFAULT_MODEL_PLACEMENT, scale: 2 } })
    ).not.toBe(hash);
    // 只改 revision / origin 不改变内容标识。
    expect(
      deriveModelContentVersion({ ...base, revision: 7 }).contentHash
    ).toBe(hash);
    expect(modelSourceHash(SCRIPT)).toBe(modelSourceHash(SCRIPT));
  });

  it("placement 校验拒绝非正 scale 与非有限数值", () => {
    expect(decodeLocalModelPlacement({ scale: 0 }).ok).toBe(false);
    expect(decodeLocalModelPlacement({ offset: { x: 1, y: 2, z: Number.NaN } }).ok).toBe(false);
    expect(decodeLocalModelPlacement({ yaw: Infinity }).ok).toBe(false);
    const ok = decodeLocalModelPlacement({ offset: { x: 1, y: 0, z: 0 }, scale: 1.5, yaw: 30 });
    expect(ok.ok && placementKey(ok.value)).toBe("1,0,0,1.5,30");
  });
});

describe("MotionDefinition 契约（任务 1.2）", () => {
  it("读取运动定义并比较基于版本", () => {
    const decoded = decodeMotionDefinition(motionNodeData());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const model = decodeModelDefinition(modelNodeData());
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(compareMotionToModel(decoded.value, model.value.contentVersion)).toBe("matched");
    expect(
      compareMotionToModel(decoded.value, { ...model.value.contentVersion, contentHash: "other" })
    ).toBe("changed");
    expect(basedOnModel(model.value.contentVersion).revision).toBe(1);
  });

  it("未知运动版本或缺失字段稳定拒绝", () => {
    expect(decodeMotionDefinition(motionNodeData({ motionScriptVersion: "v2" })).ok).toBe(false);
    expect(decodeMotionDefinition(motionNodeData({ motionRevision: 0 })).ok).toBe(false);
  });
});

describe("两类 3D 节点数据（任务 1.1/1.3）", () => {
  it("model3d 节点读取完整本地模型", () => {
    const decoded = decodeModel3DNodeData(modelNodeData());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.kind).toBe(MODEL3D_NODE_TYPE);
    expect(decoded.value.title).toBe("身体");
  });

  it("片场节点读取 items-only 内容、默认片段派生的镜头与时间线", () => {
    const decoded = decodeFilmSetNodeData(filmSetNodeData());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.kind).toBe(FILM_SET_NODE_TYPE);
    expect(decoded.value.timeline).toEqual({ duration: 4, loop: false });
    expect(decoded.value.camera.aspect).toBe("16:9");
    expect(decoded.value.origin).toBeUndefined();
    // 几何只来自 items（新建默认地面 + 来源模型）。
    expect(decoded.value.filmSetContent.items.map(item => item.id)).toEqual(["ground", ITEM_ID]);
    expect(decoded.value.filmSetAnimations!.clips[0]!.bindings[0]!.itemId).toBe(ITEM_ID);
  });

  it("严格拒绝顶层 authored 模型五字段", () => {
    const fields = filmSetNodeData();
    for (const field of ["modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "modelPlacement"]) {
      expect(decodeFilmSetNodeData({ ...fields, [field]: "x" }).ok).toBe(false);
    }
  });

  it("严格拒绝旧节点级动作/镜头/时间线字段", () => {
    const fields = filmSetNodeData();
    for (const field of ["motionScript", "motionSourceHash", "motionBasedOnModelVersion", "initialCamera", "timeline"]) {
      expect(decodeFilmSetNodeData({ ...fields, [field]: {} }).ok).toBe(false);
    }
  });

  it("空片场（无 items、无片段）是合法静态节点", () => {
    const animation = createFilmSetSnapshot({
      title: "静态",
      model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: "",
      timeline: { duration: 0, loop: false }
    });
    const empty = canonicalFilmSetFields({ ...animation, filmSetContent: { schemaVersion: 3, items: [] } });
    expect(decodeFilmSetNodeData(empty).ok).toBe(true);
  });

  it("非法画幅、负 distance 与缺失 scenePlacement 拒绝", () => {
    const fields = filmSetNodeData();
    expect(decodeFilmSetNodeData({ ...fields, scenePlacement: { scale: 0 } }).ok).toBe(false);
    // 把片段初始镜头改成非法画幅（decode 会整条拒绝）。
    const bad = structuredClone(fields) as Record<string, unknown>;
    const anims = bad.filmSetAnimations as { clips: Array<{ initialCamera: unknown }> };
    anims.clips[0]!.initialCamera = { azimuth: 0, elevation: 0, distance: 8, aspect: "7:3", focusOffset: { x: 0, y: 0, z: 0 } };
    expect(decodeFilmSetNodeData(bad).ok).toBe(false);
    const badDistance = structuredClone(fields) as Record<string, unknown>;
    const anims2 = badDistance.filmSetAnimations as { clips: Array<{ initialCamera: unknown }> };
    anims2.clips[0]!.initialCamera = { azimuth: 0, elevation: 0, distance: -1, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } };
    expect(decodeFilmSetNodeData(badDistance).ok).toBe(false);
  });

  it("buildAnimationPlayback 携带已校验 Motion IR 与片段初始镜头", () => {
    const decoded = decodeFilmSetNodeData(filmSetNodeData());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const withOrbit = withCameraOrbit(decoded.value);
    const clip = withOrbit.filmSetAnimations!.clips[0]!;
    const execution = executeMotionScript(clip.cameraMotion.motionScript, { duration: 4 });
    expect(execution.ok).toBe(true);
    if (!execution.ok) return;
    const playback = buildAnimationPlayback({
      nodeId: "anim-1",
      camera: decoded.value.camera,
      timeline: decoded.value.timeline,
      ir: execution.ir,
      time: 1.5,
      playing: true
    });
    expect(playback.nodeId).toBe("anim-1");
    expect(playback.time).toBe(1.5);
    expect(playback.duration).toBe(4);
    expect(playback.initialCamera.focusOffset).toEqual([0, 0, 0]);
    // 片场片段镜头仅允许镜头轨道。
    expect(playback.cameraMotion.length).toBeGreaterThan(0);
    expect(playback.modelMotion).toHaveLength(0);
  });
});
