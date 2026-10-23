/**
 * 动画节点检查、版本提示与播放门禁测试
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 3.1–3.5；
 *  change: 2026-10-11-extract-film-set-extension，D10 —— items-only + 独立镜头）。
 */
import { describe, expect, it } from "vitest";
import { createFilmSetSnapshot, importModelSnapshot } from "./animation-snapshot.js";
import { resolveFilmSetClip } from "./film-set-clip-view.js";
import {
  animationCheckCacheKey,
  checkAnimationMotion,
  modelPartIds,
  resolveAnimationGate
} from "./motion-validation.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";

const MODEL = `scene.group({ id: "body" });
scene.box({ id: "torso", parent: "body", size: [1, 2, 0.5] });
scene.box({ id: "left-hand", parent: "body", size: [0.3, 1, 0.3] });`;
const ITEM_ID = "model";

function animation(motionScript: string, modelScript = MODEL): FilmSetNodeData {
  return createFilmSetSnapshot({
    title: "挥手",
    model: { modelScript, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript,
    timeline: { duration: 4, loop: false }
  });
}

/** 解析默认片段为运行时视图（被检查的规范入口）。 */
function view(animation: FilmSetNodeData) {
  const resolved = resolveFilmSetClip(animation);
  if (!resolved) throw new Error("默认片段缺失");
  return resolved;
}

describe("模型部件 ID（任务 3.2 / 1.5）", () => {
  it("只返回作者显式声明的部件 ID，自动命名不参与", () => {
    const parts = modelPartIds(MODEL, "woohaa-model-js-v2");
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect([...parts.partIds].sort()).toEqual(["body", "left-hand", "torso"]);

    const auto = modelPartIds(`scene.box({ size: [1,1,1] });`, "woohaa-model-js-v2");
    if (!auto.ok) return;
    expect(auto.partIds.has("box_1")).toBe(false);
    expect(auto.partIds.size).toBe(0);
  });

  it("显式命名为 box_1 则接受", () => {
    const parts = modelPartIds(`scene.box({ id: "box_1", size: [1,1,1] });`, "woohaa-model-js-v2");
    if (!parts.ok) return;
    expect(parts.partIds.has("box_1")).toBe(true);
  });

  it("模型脚本非法时返回稳定失败", () => {
    const parts = modelPartIds("scene.box(", "woohaa-model-js-v2");
    expect(parts.ok).toBe(false);
  });
});

describe("引用与参数检查（任务 3.2）", () => {
  it("合法运动 check 通过", () => {
    const state = checkAnimationMotion(view(animation(`motion.model.rotate("body", { speed: 1 });`)));
    expect(state.validation).toBe("valid");
    expect(state.versionMatch).toBe("matched");
  });

  it("无运动脚本是合法静态节点", () => {
    // 静态片段：空镜头脚本、无 binding。检查必须 valid。
    const base = animation("");
    const cameraMotion = { motionScript: "", motionScriptLanguage: "javascript" as const, motionScriptVersion: "woohaa-motion-js-v1" as const, revision: 1, sourceHash: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } };
    const state = checkAnimationMotion({
      animation: base,
      clip: { id: "clip", name: "clip", kind: "static", timeline: { duration: 0, loop: false }, initialCamera: base.camera, cameraMotion, bindings: [] },
      content: { schemaVersion: 4, items: base.filmSetContent.items },
      initialCamera: base.camera,
      timeline: { duration: 0, loop: false },
      cameraMotion
    });
    expect(state.validation).toBe("valid");
  });

  it("目标不存在时 invalid 并给出目标 ID", () => {
    const state = checkAnimationMotion(view(animation(`motion.model.rotate("ghost", { speed: 1 });`)));
    expect(state.validation).toBe("invalid");
    expect(state.issues[0]?.targetId).toBe("ghost");
  });

  it("模型脚本不可执行时 unavailable（无法确认引用）", () => {
    const state = checkAnimationMotion(view(animation(`motion.model.rotate("body", { speed: 1 });`, "scene.box(")));
    expect(state.validation).toBe("unavailable");
  });

  it("模型内容变化但目标合法时 versionMatch=changed 且 check 通过", () => {
    const base = animation(`motion.model.rotate("body", { speed: 1 });`);
    const changed = importModelSnapshot(base, ITEM_ID, {
      modelScript: `scene.group({ id: "body" });\nscene.box({ id: "torso", parent: "body", size: [2, 2, 0.5] });`,
      modelScriptVersion: "woohaa-model-js-v2"
    });
    const state = checkAnimationMotion(view(changed));
    expect(state.versionMatch).toBe("changed");
    expect(state.validation).toBe("valid");
  });
});

describe("播放门禁（任务 3.3 / 3.4）", () => {
  it("检查通过时允许预览与拍摄，versionMatch=changed 可确认适配", () => {
    const base = animation(`motion.model.rotate("body", { speed: 1 });`);
    const changed = importModelSnapshot(base, ITEM_ID, {
      modelScript: `scene.group({ id: "body" });`,
      modelScriptVersion: "woohaa-model-js-v2"
    });
    const gate = resolveAnimationGate(checkAnimationMotion(view(changed)));
    expect(gate).toEqual({ canPreview: true, canCapture: true, canConfirmAdaptation: true, reason: null });
  });

  it("检查失败时不阻止确认适配，但阻止拍摄", () => {
    const base = animation(`motion.model.rotate("body", { speed: 1 });`);
    const changed = importModelSnapshot(base, ITEM_ID, {
      modelScript: `scene.group({ id: "other" });`,
      modelScriptVersion: "woohaa-model-js-v2"
    });
    const gate = resolveAnimationGate(checkAnimationMotion(view(changed)));
    expect(gate.canCapture).toBe(false);
    expect(gate.canPreview).toBe(false);
    expect(gate.reason).toContain("unknown-target");
  });

  it("未变化且合法时无需确认适配", () => {
    const gate = resolveAnimationGate(checkAnimationMotion(view(animation(`motion.model.rotate("body", { speed: 1 });`))));
    expect(gate.canConfirmAdaptation).toBe(false);
    expect(gate.canCapture).toBe(true);
  });
});

describe("检查缓存键（任务 3.5）", () => {
  it("区分模型内容、运动源码与时间线", () => {
    const base = animation(`motion.model.rotate("body", { speed: 1 });`);
    const key = animationCheckCacheKey(view(base));
    expect(animationCheckCacheKey(view(animation(`motion.model.rotate("body", { speed: 2 });`)))).not.toBe(key);
    const otherTimeline = createFilmSetSnapshot({
      title: "挥手",
      model: { modelScript: MODEL, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: `motion.model.rotate("body", { speed: 1 });`,
      timeline: { duration: 8, loop: false }
    });
    expect(animationCheckCacheKey(view(otherTimeline))).not.toBe(key);
  });
});
