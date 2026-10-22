/**
 * 动画播放控制器测试
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1/4.3）。
 */
import { describe, expect, it } from "vitest";
import { createFilmSetSnapshot, filmSetAnimationsOf, type FilmSetNodeData, type BevyAnimationPlayback } from "@woohaa3/contracts";
import { AnimationPlaybackController } from "../src/preview/shared/playback-controller.js";

const MODEL = `scene.group({ id: "body" });
scene.box({ id: "torso", parent: "body", size: [1, 2, 0.5] });`;

function animation(motionScript: string, duration = 4): FilmSetNodeData {
  return createFilmSetSnapshot({
    title: "挥手",
    model: { modelScript: MODEL, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript,
    timeline: { duration, loop: false }
  });
}

/** 显式注入一个零时长、无动作的片段（空动作脚本不自动建片段，D8）。 */
function withEmptyClip(source: FilmSetNodeData): FilmSetNodeData {
  return {
    ...source,
    filmSetAnimations: {
      schemaVersion: 3,
      defaultClipId: "clip-1",
      clips: [{
        id: "clip-1",
        name: "默认动画",
        kind: "static",
        timeline: { duration: 0, loop: false },
        initialCamera: source.camera,
        cameraMotion: {
          motionScript: "",
          motionScriptLanguage: "javascript",
          motionScriptVersion: "woohaa-motion-js-v1",
          revision: 1,
          sourceHash: "camera",
          basedOnModelVersion: { revision: 1, contentHash: "camera" }
        },
        bindings: []
      }]
    }
  };
}

class Harness {
  readonly published: BevyAnimationPlayback[] = [];
  readonly controller: AnimationPlaybackController;
  private scheduled: (() => void) | null = null;
  private nowMs = 0;

  constructor(readonly animations: Map<string, FilmSetNodeData>) {
    this.controller = new AnimationPlaybackController({
      readAnimation: (nodeId) => this.animations.get(nodeId) ?? null,
      publish: (playback) => {
        if (playback) this.published.push(playback);
      },
      schedule: (run) => {
        this.scheduled = run;
        return () => {
          this.scheduled = null;
        };
      },
      now: () => this.nowMs
    });
  }

  advance(ms: number): void {
    this.nowMs += ms;
    this.scheduled?.();
  }
}

describe("AnimationPlaybackController", () => {
  it("renaming a clip preserves the compiled session and playback time", () => {
    const source = animation(`motion.model.rotate("torso", { speed: 1 });`);
    source.filmSetAnimations = filmSetAnimationsOf(source);
    const animations = new Map([["a", source]]);
    const harness = new Harness(animations);
    harness.controller.select("a");
    harness.controller.seek(2);
    const count = harness.controller.compilationCount();
    const renamed = structuredClone(source);
    renamed.filmSetAnimations!.clips[0].name = "新名称";
    animations.set("a", renamed);
    harness.controller.select("a");
    expect(harness.controller.compilationCount()).toBe(count);
    expect(harness.controller.time()).toBe(2);
  });
  it("repeated hover reuses the compiled clip but starts a fresh clock at zero", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a"); harness.controller.seek(2);
    const count = harness.controller.compilationCount();
    harness.controller.select(null); harness.controller.select("a");
    expect(harness.controller.compilationCount()).toBe(count);
    expect(harness.controller.time()).toBe(0);
    expect(harness.controller.isPlaying()).toBe(true);
    harness.controller.dispose();
  });
  it("zero-duration clip remains a viewable paused frame without scheduled work", () => {
    const harness = new Harness(new Map([["a", withEmptyClip(animation("", 0))]]));
    harness.controller.select("a", undefined, { paused: true, viewMode: "focus-preview" });
    expect(harness.controller.activeNodeId()).toBe("a");
    harness.controller.play();
    harness.advance(1000);
    expect(harness.controller.isPlaying()).toBe(false);
    expect(harness.controller.time()).toBe(0);
    expect(harness.published.at(-1)?.time).toBe(0);
  });
  it("pausing cancels frame work; ticks reuse compiled track objects", () => {
    let scheduled = 0;
    let cancelled = 0;
    const published: BevyAnimationPlayback[] = [];
    const controller = new AnimationPlaybackController({
      readAnimation: () => animation(`motion.model.rotate("torso", {speed:1});`),
      publish: projection => { if (projection) published.push(projection); },
      schedule: () => { scheduled += 1; return () => { cancelled += 1; }; }
    });
    controller.select("a");
    controller.tick(1000);
    controller.tick(2000);
    expect(published.at(-1)!.objects).toBe(published[0].objects);
    expect(scheduled).toBe(1);
    controller.pause();
    expect(cancelled).toBe(1);
    controller.seek(2);
    expect(scheduled).toBe(1);
    controller.play();
    expect(scheduled).toBe(2);
    controller.dispose();
    expect(cancelled).toBe(2);
  });

  it("focus selection starts paused and play at end restarts", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", {speed:1});`)]]));
    harness.controller.select("a", undefined, { paused: true });
    expect(harness.controller.isPlaying()).toBe(false);
    harness.controller.seek(4);
    harness.controller.play();
    expect(harness.controller.time()).toBe(0);
    expect(harness.controller.isPlaying()).toBe(true);
  });
  it("选中动画节点后发布含运动 IR 的投影并从第 0 秒播放", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a");
    expect(harness.controller.activeNodeId()).toBe("a");
    expect(harness.controller.isPlaying()).toBe(true);
    const latest = harness.published.at(-1)!;
    expect(latest.nodeId).toBe("a");
    expect(latest.objects).toHaveLength(1);
    expect(latest.objects![0]!.modelMotion).toHaveLength(1);
    expect(latest.time).toBe(0);
  });

  it("推进时钟并在非循环结束时停在 duration", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a");
    harness.advance(1000);
    harness.advance(1000);
    expect(harness.controller.time()).toBeGreaterThan(0.9);
    harness.advance(10000);
    expect(harness.controller.time()).toBe(4);
    expect(harness.controller.isPlaying()).toBe(false);
  });

  it("循环在 duration 处回绕", () => {
    const looping = createFilmSetSnapshot({
      title: "循环",
      model: { modelScript: MODEL, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: `motion.model.rotate("torso", { speed: 1 });`,
      timeline: { duration: 2, loop: true }
    });
    const harness = new Harness(new Map([["a", looping]]));
    harness.controller.select("a");
    harness.advance(1000);
    harness.advance(2500);
    // 首次 tick 只记录起点；随后 2.5 秒按 duration=2 回绕到 0.5。
    expect(harness.controller.time()).toBeCloseTo(0.5, 3);
  });

  it("停止回到第 0 秒，seek 钳制并暂停", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a");
    harness.controller.seek(99);
    expect(harness.controller.time()).toBe(4);
    expect(harness.controller.isPlaying()).toBe(false);
    harness.controller.stop();
    expect(harness.controller.time()).toBe(0);
  });

  it("切换到另一节点重建会话，切到 null 清除投影", () => {
    const harness = new Harness(new Map([
      ["a", animation(`motion.model.rotate("torso", { speed: 1 });`)],
      ["b", animation(`motion.model.rotate("torso", { speed: 2 });`)]
    ]));
    harness.controller.select("a");
    harness.advance(1000);
    harness.controller.select("b");
    expect(harness.controller.activeNodeId()).toBe("b");
    expect(harness.controller.time()).toBe(0);
    harness.controller.select(null);
    expect(harness.controller.activeNodeId()).toBeNull();
  });

  it("同一节点且内容身份不变时保留时钟", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a", "hash-1");
    harness.advance(1000);
    const before = harness.controller.time();
    harness.controller.select("a", "hash-1");
    expect(harness.controller.time()).toBe(before);
  });

  it("运动目标非法时拒绝建立会话（不发布投影）", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("ghost", { speed: 1 });`)]]));
    harness.controller.select("a");
    expect(harness.controller.activeNodeId()).toBeNull();
    expect(harness.published).toHaveLength(0);
  });

  it("定义变化后 invalidate 重建会话", () => {
    const animations = new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]);
    const harness = new Harness(animations);
    harness.controller.select("a");
    harness.advance(1000);
    animations.set("a", animation(`motion.model.rotate("torso", { speed: 3 });`));
    harness.controller.invalidate();
    expect(harness.controller.time()).toBe(0);
    expect(harness.controller.activeNodeId()).toBe("a");
  });

  it("pinForCapture 冻结到指定时间并在恢复后回到原状态", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a");
    harness.advance(1000);
    harness.advance(500);
    const before = harness.controller.time();
    const restore = harness.controller.pinForCapture(2.5);
    expect(restore).not.toBeNull();
    expect(harness.controller.time()).toBe(2.5);
    expect(harness.controller.isPlaying()).toBe(false);
    // 冻结期间推进不改变时间。
    harness.advance(1000);
    expect(harness.controller.time()).toBe(2.5);
    restore!();
    expect(harness.controller.time()).toBe(before);
    expect(harness.controller.isPlaying()).toBe(true);
  });

  it("snapshotHash 标识当前会话版本", () => {
    const harness = new Harness(new Map([["a", animation(`motion.model.rotate("torso", { speed: 1 });`)]]));
    harness.controller.select("a", "hash-x");
    expect(harness.controller.snapshotHash()).toBe("hash-x");
    harness.controller.select(null);
    expect(harness.controller.snapshotHash()).toBeNull();
  });
});
