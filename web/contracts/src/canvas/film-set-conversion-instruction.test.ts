/**
 * 转换指令、结构化候选 schema 与归一（任务 2.3/2.4）。
 *
 * 覆盖：按来源派生的指令、结构化 schema 形状约束、扁平淡候选归一为可校验的 domain 候选，
 * 归一结果能通过完整领域校验（非法候选仍被拒绝）。非渲染检查。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/aggregate.js";
import type { StoredAsset } from "./domain/types.js";
import {
  buildFilmSetConversionInstruction,
  defaultFilmSetConversionPrompt,
  filmSetConversionCandidateSchema,
  normalizeFilmSetConversionOutput,
  validateFilmSetConversionCandidate,
  filmSetConversionCapabilityRejectionCode,
  TEXT_ONLY_CONVERSION_CAPABILITIES,
  type FilmSetConversionAdapterCapabilities
} from "./film-set-conversion.js";
import { modelPrimitiveConstraintsText, modelRenderBudgetText } from "./model-api-descriptor.js";

const NOW = "2026-10-13T00:00:00.000Z";

function canvasWithAsset(asset: StoredAsset) {
  const base = createEmptyWoohaa3ServerCanvas("c", NOW);
  return { ...base, assets: [asset] };
}

const groundAsset = (): StoredAsset => ({
  id: "asset-1",
  title: "图片",
  mediaKind: "image",
  source: "uploaded",
  status: "ready",
  createdAt: NOW,
  metadata: { checksum: "h" }
});

const unitTransform = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };

/** 重建画面的模型项（必须存在，否则候选被拒）。 */
const modelItem = (id = "obj") => ({
  id,
  kind: "model",
  name: "对象",
  localTransform: unitTransform,
  modelScript: `scene.box({ id: "${id}", size: [1, 1, 1] });`,
  modelScriptVersion: "woohaa-model-js-v2"
});

const groundItem = (id = "g") => ({
  id,
  kind: "ground",
  name: "地面",
  localTransform: unitTransform,
  size: { width: 8, depth: 8 },
  color: null
});

describe("转换指令与结构化候选 schema（任务 2.3）", () => {
  it("默认提示词与弹窗同源，提交默认值不会重复附加，编辑值替换默认值", () => {
    for (const sourceKind of ["image", "video"] as const) {
      const prompt = defaultFilmSetConversionPrompt(sourceKind);
      const input = { sourceKind, title: "片场", nativeVideo: false };
      const fallback = buildFilmSetConversionInstruction(input);
      expect(fallback).toContain(prompt);
      expect(buildFilmSetConversionInstruction({ ...input, instruction: prompt })).toBe(fallback);
      expect(fallback.split(prompt)).toHaveLength(2);
      const edited = buildFilmSetConversionInstruction({ ...input, instruction: "只保留主角，背景简化" });
      expect(edited).toContain("Scene instruction: 只保留主角，背景简化");
      expect(edited).not.toContain(prompt);
      expect(buildFilmSetConversionInstruction({ ...input, instruction: "   " })).toBe(fallback);
    }
  });

  it("图片指令要求真实像素、items-only、重建模型对象与镜头还原构图", () => {
    const text = buildFilmSetConversionInstruction({
      sourceKind: "image", title: "图片 · 片场", nativeVideo: false, assetIds: ["asset-1"]
    });
    expect(text).toMatch(/actual image content is attached/);
    expect(text).toMatch(/items-only/);
    expect(text).toMatch(/asset-1/);
    expect(text).toMatch(/NEVER invent external URLs/);
    // 必须真正重建画面：至少一个 model 对象，且用 sceneCamera 还原构图。
    expect(text).toMatch(/kind "model"/);
    expect(text).toMatch(/Rebuild the visible scene as editable model objects/);
    expect(text).toMatch(/sceneCamera.*reproduce the source/);
    // 相机字段单位明确为弧度（模型曾把 elevation 当角度写成 7 → 钳到正上方，朝向错）。
    expect(text).toMatch(/azimuth` and `elevation` are in RADIANS/);
    // 世界单位与地面尺寸指引（模型曾写出 200×200 地面 → 预览里人物微小）。
    expect(text).toMatch(/life-like scale/);
    expect(text).toMatch(/200×200 is WRONG/);
    // 给出可运行的具体调用形式（避免模型写出引用未定义全局 SceneBuilder 的脚本被拒）。
    expect(text).toMatch(/NO global named `SceneBuilder`/);
    expect(text).toContain("scene.box(");
    expect(text).toContain("scene.material(");
    // 明确 scene/rangeNum 是注入参数，禁止顶层重声明（否则编译报 already declared）。
    expect(text).toMatch(/injected function parameters/);
    expect(text).toMatch(/do NOT declare or assign a top-level/);
    // 声明渲染预算：结构合法但超预算的候选会被整份拒绝。
    expect(text).toContain(modelRenderBudgetText());
    // 声明图元合法性约束（capsule 高度等隐式几何规则）。
    expect(text).toContain(modelPrimitiveConstraintsText());
  });

  it("带修复指引时回喂上一份候选与具体校验错误", () => {
    const text = buildFilmSetConversionInstruction({
      sourceKind: "image", title: "图片 · 片场", nativeVideo: false,
      repair: { candidate: { items: [] }, message: "对象 scarf 的 capsule 总高度不得小于直径", attempt: 1 }
    });
    expect(text).toMatch(/PREVIOUS candidate was REJECTED/);
    expect(text).toContain("对象 scarf 的 capsule 总高度不得小于直径");
    expect(text).toContain('"items":[]');
    expect(text).toMatch(/Fix ONLY the reported problem/);
  });

  it("视频指令记录处理范围与帧时间戳；原生视频声明为原生输入并强制还原运镜与对象动作", () => {
    const frames = buildFilmSetConversionInstruction({
      sourceKind: "video", title: "视频 · 片场", nativeVideo: false,
      range: { startSeconds: 1, endSeconds: 5 }, durationSeconds: 10, frameTimestamps: [1, 3, 5]
    });
    expect(frames).toMatch(/1s–5s/);
    expect(frames).toMatch(/1\.000s, 3\.000s, 5\.000s/);
    expect(frames).toMatch(/frame set with timestamps/);
    // 视频必须还原动作，且给出可运行的动作脚本 API（否则模型只能留空 → 静态）。
    expect(frames).toMatch(/you MUST reproduce it/);
    expect(frames).toContain("cameraMotionScript");
    expect(frames).toContain("motion.camera.tween");
    expect(frames).toContain("motion.model.keyframes");
    expect(frames).toMatch(/radians/);
    // 禁工具的转换回合不得出现 MCP 工具/已有场景规则，避免引导模型去调用工具。
    expect(frames).not.toContain("mutate_film_set_item");
    expect(frames).not.toContain("保留已有场景");
    // 相机字段单位明确为弧度、仰角范围受限。
    expect(frames).toMatch(/azimuth` and `elevation` are in RADIANS/);

    const native = buildFilmSetConversionInstruction({
      sourceKind: "video", title: "视频 · 片场", nativeVideo: true
    });
    expect(native).toMatch(/native video input/);
    expect(native).toMatch(/kind "model"/);
  });

  it("结构化 schema 声明深响应式约束（required/additionalProperties）", () => {
    const schema = filmSetConversionCandidateSchema() as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["items", "clips", "defaultClipId", "sceneCamera", "note"]));
  });

  it("归一后的合法候选通过完整领域校验；引用不存在资产被拒", () => {
    const ok = normalizeFilmSetConversionOutput({
      items: [modelItem("solid"), groundItem("g")],
      clips: null, defaultClipId: null, sceneCamera: null, note: null
    });
    const validated = validateFilmSetConversionCandidate({
      candidate: ok,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    expect(validated.ok).toBe(true);

    // 媒体项引用不存在的资产：整份拒绝。
    const bad = normalizeFilmSetConversionOutput({
      items: [
        modelItem("solid"),
        { id: "img", kind: "image", name: "图", localTransform: unitTransform, assetId: "missing", aspectRatio: 1.5 }
      ],
      clips: null, defaultClipId: null, sceneCamera: null, note: null
    });
    const rejected = validateFilmSetConversionCandidate({
      candidate: bad,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    expect(rejected.ok).toBe(false);
  });

  it("只放入源素材（平媒）而没有模型对象时整份拒绝（必须真正重建画面）", () => {
    // 引用合法且 ready 的源资产，但整份片场只有平面媒体项、没有 model 对象。
    const flat = normalizeFilmSetConversionOutput({
      items: [{ id: "img", kind: "image", name: "源图", localTransform: unitTransform, assetId: "asset-1", aspectRatio: 1.5 }],
      clips: null, defaultClipId: null, sceneCamera: null, note: null
    });
    const result = validateFilmSetConversionCandidate({
      candidate: flat,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("candidate-invalid");
  });

  it("片段带有对象 binding 与镜头运动也能通过完整校验", () => {
    const normalized = normalizeFilmSetConversionOutput({
      items: [modelItem("solid"), groundItem("box")],
      clips: [{
        id: "clip-1", name: "主动作", duration: 3, loop: false, cameraMotionScript: "",
        camera: { azimuth: 0, elevation: 0.5, distance: 6, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
        bindings: [{ itemId: "box", motionScript: "return 0;", duration: 3, loop: false }]
      }],
      defaultClipId: "clip-1", sceneCamera: null, note: "已生成场景，部分动作未还原"
    });
    const validated = validateFilmSetConversionCandidate({
      candidate: normalized,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.filmSetAnimations.clips[0]?.bindings).toHaveLength(1);
      expect(validated.value.note).toBe("已生成场景，部分动作未还原");
    }
  });

  it("镜头仰角必须落在 ±π/2 弧度内（把角度当弧度写的候选被拒，供修复轮拿到具体原因）", () => {
    const candidate = (sceneCamera: unknown, clipCamera?: unknown) => normalizeFilmSetConversionOutput({
      items: [modelItem("solid")],
      clips: clipCamera
        ? [{ id: "clip-1", name: "镜头", duration: 3, loop: false, cameraMotionScript: "", camera: clipCamera, bindings: [] }]
        : null,
      defaultClipId: clipCamera ? "clip-1" : null,
      sceneCamera,
      note: null
    });
    const run = (input: unknown) => validateFilmSetConversionCandidate({
      candidate: input,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    const camera = (elevation: number) => ({ azimuth: 0, elevation, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 1.2, z: 0 } });

    // elevation = 7 是「角度」写法；按弧度 ≈ 401°，渲染时会被静默钳到正上方（镜头朝向错）。
    const badScene = run(candidate(camera(7)));
    expect(badScene.ok).toBe(false);
    if (!badScene.ok) {
      expect(badScene.code).toBe("candidate-invalid");
      expect(badScene.message).toMatch(/弧度/);
      expect(badScene.message).toMatch(/π\/2/);
    }
    // 合法弧度值（含负仰角）通过。
    expect(run(candidate(camera(0.2))).ok).toBe(true);
    expect(run(candidate(camera(-0.6))).ok).toBe(true);
    // 片段镜头同样受限，且消息定位到具体片段。
    const badClip = run(candidate(null, camera(-7)));
    expect(badClip.ok).toBe(false);
    if (!badClip.ok) expect(badClip.message).toMatch(/片段 clip-1/);
  });

  it("地面尺寸过大被拒（过大的地面会把主体缩成一点）", () => {
    const run = (input: unknown) => validateFilmSetConversionCandidate({
      candidate: input,
      canvas: canvasWithAsset(groundAsset()),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    const withGround = (size: { width: number; depth: number }) => normalizeFilmSetConversionOutput({
      items: [modelItem("solid"), { id: "floor", kind: "ground", name: "地面", localTransform: unitTransform, size, color: null }],
      clips: null, defaultClipId: null, sceneCamera: null, note: null
    });
    // 200×200 地面（上游实测写法）被**具体**拒绝，进入有界修复轮。
    const bad = run(withGround({ width: 200, depth: 200 }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("candidate-invalid");
      expect(bad.message).toMatch(/地面 floor/);
      expect(bad.message).toMatch(/过大/);
    }
    // 接近主体占地的地面（默认 8）通过。
    expect(run(withGround({ width: 8, depth: 8 })).ok).toBe(true);
  });
});

describe("能力判定错误分类（任务 1.1/2.1）", () => {
  it("未知能力 → model-not-vision-capable；仅文字 → model-no-structured-output", () => {
    const unknown = filmSetConversionCapabilityRejectionCode("image", undefined);
    expect(unknown?.code).toBe("model-not-vision-capable");
    const textOnly = filmSetConversionCapabilityRejectionCode("image", TEXT_ONLY_CONVERSION_CAPABILITIES);
    expect(textOnly?.code).toBe("model-no-structured-output");
    const vision: FilmSetConversionAdapterCapabilities = {
      structuredCandidateOutput: true,
      input: { imageInput: true, maxImages: 4, videoInput: false, maxFrames: 4, maxDurationSeconds: 0 }
    };
    expect(filmSetConversionCapabilityRejectionCode("image", vision)).toBeNull();
    // 视频：多图能力（maxImages>1）可用于抽帧，因此可用；仅单图能力则拒绝。
    expect(filmSetConversionCapabilityRejectionCode("video", vision)).toBeNull();
    const singleImage: FilmSetConversionAdapterCapabilities = {
      structuredCandidateOutput: true,
      input: { imageInput: true, maxImages: 1, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 }
    };
    expect(filmSetConversionCapabilityRejectionCode("video", singleImage)?.code).toBe("model-not-vision-capable");
  });
});
