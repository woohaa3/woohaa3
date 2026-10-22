/**
 * 拍摄镜头背景与导出 profile 的契约回归
 * （change: 2026-10-19-extend-film-set-for-motion-graphics，D6/D7）。
 */
import { describe, expect, it } from "vitest";
import { createMotionSnapshot } from "./animation-snapshot.js";
import {
  DEFAULT_FILM_SET_EXPORT_PROFILE,
  FILM_SET_EXPORT_PROFILES,
  filmSetExportBitrate,
  filmSetExportFrameRate,
  filmSetExportProfileLabel,
  filmSetExportVideoSize,
  isFilmSetExportProfile,
  readFilmSetExportProfile
} from "./film-set-export-profile.js";
import {
  cloneFilmSetShotForNewId,
  decodeFilmSetAnimations,
  deriveFilmSetShotKind,
  filmSetBackdropIsCustom,
  readFilmSetBackdrop,
  type FilmSetAnimationClip
} from "./film-set-animations.js";
import { applyFilmSetClipPatch, filmSetClipPrecondition } from "./film-set-clip-ops.js";
import { canonicalFilmSetFields, filmSetAnimationsOf } from "./film-set-clip-view.js";
import { emptyFilmSetContent } from "./film-set-content.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import { shotReferenceContentIdentity } from "./film-set-shot-reference.js";

describe("导出 profile（D7）", () => {
  it("standard 与改动前的 720p30 完全一致", () => {
    expect(DEFAULT_FILM_SET_EXPORT_PROFILE).toBe("standard");
    expect(filmSetExportVideoSize("16:9")).toEqual({ width: 1280, height: 720 });
    expect(filmSetExportFrameRate("standard")).toBe(30);
    expect(filmSetExportBitrate("standard")).toBe(4_000_000);
  });

  it("hd / hd60 用短边 1080 并保持画幅、取偶数", () => {
    expect(filmSetExportVideoSize("16:9", "hd")).toEqual({ width: 1920, height: 1080 });
    expect(filmSetExportVideoSize("16:9", "hd60")).toEqual({ width: 1920, height: 1080 });
    expect(filmSetExportVideoSize("9:16", "hd")).toEqual({ width: 1080, height: 1920 });
    expect(filmSetExportVideoSize("1:1", "hd60")).toEqual({ width: 1080, height: 1080 });
    expect(filmSetExportVideoSize("4:3", "hd")).toEqual({ width: 1440, height: 1080 });
    // 长边必须偶数（H.264 要求）。
    for (const aspect of ["16:9", "9:16", "21:9", "4:3", "3:4", "1:1"]) {
      for (const profile of FILM_SET_EXPORT_PROFILES) {
        const size = filmSetExportVideoSize(aspect, profile);
        expect(size.width % 2, `${aspect}@${profile}`).toBe(0);
        expect(size.height % 2, `${aspect}@${profile}`).toBe(0);
      }
    }
    expect(filmSetExportFrameRate("hd60")).toBe(60);
    expect(filmSetExportBitrate("hd60")).toBe(12_000_000);
  });

  it("未知档位回退缺省，标签稳定", () => {
    expect(isFilmSetExportProfile("4k")).toBe(false);
    expect(readFilmSetExportProfile("4k")).toBe("standard");
    expect(readFilmSetExportProfile("hd60")).toBe("hd60");
    expect(filmSetExportProfileLabel("standard")).toBe("720p30");
    expect(filmSetExportProfileLabel("hd60")).toBe("1080p60");
  });
});

describe("拍摄镜头背景（D6）", () => {
  it("接受 theme 与六位 hex，拒绝其它写法", () => {
    expect(readFilmSetBackdrop(undefined)).toEqual({ ok: true, value: undefined });
    expect(readFilmSetBackdrop("theme")).toEqual({ ok: true, value: undefined });
    expect(readFilmSetBackdrop("#000000")).toEqual({ ok: true, value: "#000000" });
    expect(readFilmSetBackdrop("#AABBCC")).toEqual({ ok: true, value: "#aabbcc" });
    expect(readFilmSetBackdrop("#0008")).toMatchObject({ ok: false });
    expect(readFilmSetBackdrop("#abc")).toMatchObject({ ok: false });
    expect(readFilmSetBackdrop("black")).toMatchObject({ ok: false });
  });

  const camera = { azimuth: 0, elevation: Math.PI / 4, distance: 10, aspect: "16:9" as const, focusOffset: { x: 0, y: 0, z: 0 } };
  const motion = () => createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } });
  const clip = (overrides: Partial<FilmSetAnimationClip> = {}): FilmSetAnimationClip => ({
    id: "clip-a",
    name: "镜头 A",
    kind: "dynamic",
    timeline: { duration: 3, loop: false },
    initialCamera: camera,
    cameraMotion: motion(),
    bindings: [],
    ...overrides
  });
  const animation = (clips: FilmSetAnimationClip[]): FilmSetNodeData => ({
    kind: "composite-asset",
    title: "片场",
    scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    sceneCamera: camera,
    camera: camera,
    timeline: { duration: 3, loop: false },
    filmSetContent: emptyFilmSetContent(),
    filmSetAnimations: { schemaVersion: 3, defaultClipId: clips[0]?.id ?? null, clips }
  });

  it("旧镜头不带 backdrop 时解码不写入字段且身份不变", () => {
    const decoded = decodeFilmSetAnimations({ schemaVersion: 3, defaultClipId: "clip-a", clips: [JSON.parse(JSON.stringify(clip()))] }, emptyFilmSetContent());
    expect(decoded.ok, decoded.ok ? "" : decoded.reason).toBe(true);
    if (!decoded.ok) return;
    expect("backdrop" in decoded.value.clips[0]!).toBe(false);
  });

  it("backdrop 通过 mutate_film_set_clip 的 backdrop 操作写入，theme 等于删除", () => {
    const original = animation([clip()]);
    const hash = filmSetClipPrecondition(filmSetAnimationsOf(original), "clip-a", { kind: "backdrop", backdrop: "#000000" });
    const applied = applyFilmSetClipPatch({
      animation: original,
      clipId: "clip-a",
      expectedHash: hash,
      op: { kind: "backdrop", backdrop: "#000000" }
    });
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.clips[0]!.backdrop).toBe("#000000");
    expect(filmSetBackdropIsCustom(applied.value.clips[0]!)).toBe(true);

    const resetHash = filmSetClipPrecondition(applied.value, "clip-a", { kind: "backdrop", backdrop: "theme" });
    const reset = applyFilmSetClipPatch({ animation: animation(applied.value.clips), clipId: "clip-a", expectedHash: resetHash, op: { kind: "backdrop", backdrop: "theme" } });
    expect(reset.ok, reset.ok ? "" : reset.reason).toBe(true);
    if (!reset.ok) return;
    expect("backdrop" in reset.value.clips[0]!).toBe(false);
  });

  it("非法颜色被拒绝且镜头不变", () => {
    const original = animation([clip()]);
    const hash = filmSetClipPrecondition(filmSetAnimationsOf(original), "clip-a", { kind: "backdrop", backdrop: "#0008" });
    const result = applyFilmSetClipPatch({ animation: original, clipId: "clip-a", expectedHash: hash, op: { kind: "backdrop", backdrop: "#0008" } });
    expect(result).toMatchObject({ ok: false, code: "invalid-payload" });
  });

  it("复制镜头继承背景", () => {
    const source = clip({ backdrop: "#000000" });
    const copy = cloneFilmSetShotForNewId(source, "clip-b", "副本");
    expect(copy.id).toBe("clip-b");
    expect(copy.backdrop).toBe("#000000");
    expect(copy.cameraMotion).toEqual(source.cameraMotion);
  });

  it("「使用选中镜头构图」只改 initialCamera，背景保留", () => {
    const source = animation([clip({ backdrop: "#000000" })]);
    const hash = filmSetClipPrecondition(filmSetAnimationsOf(source), "clip-a", { kind: "camera", initialCamera: camera });
    const applied = applyFilmSetClipPatch({
      animation: source,
      clipId: "clip-a",
      expectedHash: hash,
      op: { kind: "camera", initialCamera: { ...camera, azimuth: 1.1, distance: 20 } }
    });
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.clips[0]!.backdrop).toBe("#000000");
    expect(applied.value.clips[0]!.initialCamera.distance).toBe(20);
  });

  it("背景变化使该镜头参考身份变化，其它镜头不受影响", () => {
    const base = animation([clip(), clip({ id: "clip-b", name: "镜头 B" })]);
    const changed = animation([clip({ backdrop: "#000000" }), clip({ id: "clip-b", name: "镜头 B" })]);
    const a1 = shotReferenceContentIdentity({ animation: base, clipId: "clip-a" });
    const a2 = shotReferenceContentIdentity({ animation: changed, clipId: "clip-a" });
    const b1 = shotReferenceContentIdentity({ animation: base, clipId: "clip-b" });
    const b2 = shotReferenceContentIdentity({ animation: changed, clipId: "clip-b" });
    expect(a1).not.toBe(a2);
    expect(b1).toBe(b2);
  });

  it("canonical 写入保留 backdrop，且默认镜头视图派生稳定", () => {
    const withBackdrop = animation([clip({ backdrop: "#000000" })]);
    expect(canonicalFilmSetFields(withBackdrop).filmSetAnimations).toMatchObject({ clips: [{ backdrop: "#000000" }] });
    expect(deriveFilmSetShotKind(clip())).toBe("dynamic");
  });
});
