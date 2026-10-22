/**
 * 拍摄镜头 schema 2 → 3 离线迁移纯计划回归
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 3.1）。
 *
 * 覆盖：正时长→dynamic、合法零时长→static、非法零时长（带动作/时序）冲突报告不丢内容、
 * 重跑无净变化、已是 schema 3 原样返回。
 */
import { describe, expect, it } from "vitest";
import {
  createFilmSetSnapshot,
  createMotionSnapshot,
  canonicalFilmSetFields,
  decodeFilmSetNodeData,
  type FilmSetAnimationClip,
  type FilmSetNodeData
} from "@woohaa3/contracts";
import { planFilmSetAnimationsV3, planFilmSetNodeV3 } from "./film-set-shooting-shot-migration.js";

const CAMERA = { azimuth: 0, elevation: 0.3, distance: 6, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } } as const;

function content() {
  return createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    timeline: { duration: 0, loop: false }
  }).filmSetContent;
}

function cameraMotion(script = "") {
  return createMotionSnapshot({ motionScript: script, basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } });
}

function legacyClip(overrides: Partial<FilmSetAnimationClip> & { id: string }): FilmSetAnimationClip & { kind?: undefined } {
  return {
    name: overrides.id,
    timeline: { duration: 0, loop: false },
    initialCamera: { ...CAMERA },
    cameraMotion: cameraMotion(),
    bindings: [],
    ...overrides
  } as FilmSetAnimationClip & { kind?: undefined };
}

describe("schema2 → schema3 拍摄镜头迁移（任务 3.1）", () => {
  it("正时长固定机位镜头迁移为 dynamic，保留时长与对象动作", () => {
    const bindings = [{ itemId: "model", playback: { startTime: 0, duration: 4, timeScale: 1, loop: false } }];
    const result = planFilmSetAnimationsV3(
      { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1", timeline: { duration: 4, loop: true }, bindings })] },
      content()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toBe(true);
    expect(result.value.clips[0]!.kind).toBe("dynamic");
    expect(result.value.clips[0]!.timeline).toEqual({ duration: 4, loop: true });
    expect(result.value.clips[0]!.bindings[0]!.playback.duration).toBe(4);
  });

  it("符合静态约束的零时长镜头迁移为 static", () => {
    const result = planFilmSetAnimationsV3(
      { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1" })] },
      content()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.clips[0]!.kind).toBe("static");
    expect(result.value.clips[0]!.timeline).toEqual({ duration: 0, loop: false });
  });

  it("零时长但带镜头动作的镜头报告冲突且不改写内容", () => {
    const input = { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1", cameraMotion: cameraMotion(`motion.camera.tween({ id:"orbit", property:"azimuth", startTime:0, endTime:1, from:0, to:1 });`) })] };
    const before = JSON.stringify(input);
    const result = planFilmSetAnimationsV3(input, content());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("clip-1");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("零时长但带正时序媒体的镜头报告冲突", () => {
    const result = planFilmSetAnimationsV3(
      { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1", bindings: [{ itemId: "model", playback: { startTime: 0, duration: 3, timeScale: 1, loop: false } }] })] },
      content()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("clip-1");
  });

  it("已是 schema 3 时重跑无净变化", () => {
    const first = planFilmSetAnimationsV3(
      { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1", timeline: { duration: 4, loop: false } })] },
      content()
    );
    if (!first.ok) throw new Error(first.reason);
    const second = planFilmSetAnimationsV3(first.value, content());
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.changed).toBe(false);
    expect(second.value).toEqual(first.value);
  });

  it("节点级迁移：schema2 内容迁移后生产解码通过，且补预览所需镜头", () => {
    const base = createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
      timeline: { duration: 3, loop: false }
    });
    const legacyFields = canonicalFilmSetFields(base);
    legacyFields.filmSetAnimations = { schemaVersion: 2, defaultClipId: "clip-1", clips: [legacyClip({ id: "clip-1", timeline: { duration: 3, loop: false } })] };
    const result = planFilmSetNodeV3(legacyFields);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toBe(true);
    expect(result.value.filmSetAnimations!.schemaVersion).toBe(3);
    expect(result.value.filmSetAnimations!.clips[0]!.kind).toBe("dynamic");
    // 迁移产物可被生产严格解码再次接受（重跑幂等）。
    const again = planFilmSetNodeV3(canonicalFilmSetFields(result.value as FilmSetNodeData));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.changed).toBe(false);
    expect(decodeFilmSetNodeData(canonicalFilmSetFields(result.value as FilmSetNodeData)).ok).toBe(true);
  });
});
