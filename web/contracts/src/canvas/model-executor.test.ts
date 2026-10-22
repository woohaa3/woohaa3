/**
 * 版本化 JavaScript modelScript 执行骨架测试
 * （change: replace-godot-canvas-runtime-with-bevy，任务 4.1–4.4；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only，删除 V1 recorder/executor）。
 */
import { describe, expect, it } from "vitest";
import { hashModelScript, rangeNum } from "./model-executor.js";
import { executeModelScriptVersioned, SceneBuilderV2 } from "./model-executor-v2.js";

describe("SceneBuilderV2", () => {
  it("records shape ops with generated ids", () => {
    const builder = new SceneBuilderV2();
    const root = builder.group({});
    builder.box({ parent: root, size: [1, 1, 1] });
    expect(root).toBe("group_1");
    const raw = builder.raw();
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({ t: "group", id: "group_1" });
    expect(raw[1]).toMatchObject({ t: "box", parent: "group_1" });
  });
});

describe("rangeNum", () => {
  it("supports one/two/three argument forms", () => {
    expect(rangeNum(3)).toEqual([0, 1, 2]);
    expect(rangeNum(1, 4)).toEqual([1, 2, 3]);
    expect(rangeNum(0, 6, 2)).toEqual([0, 2, 4]);
    expect(rangeNum(5, 0, -2)).toEqual([5, 3, 1]);
  });
});

describe("executeModelScriptVersioned（V2-only）", () => {
  it("executes a valid V2 script", () => {
    const result = executeModelScriptVersioned(
      "scene.box({ id: 'body', size: [1, 2, 1], color: '#ff0000' });",
      "woohaa-model-js-v2"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.version).toBe("woohaa-model-scene-ir-v2");
    expect(result.scene.ops).toHaveLength(1);
  });

  it("rejects the retired V1 version with version-mismatch", () => {
    const result = executeModelScriptVersioned("scene.box({ id: 'b' });", "woohaa-model-js-v1");
    expect(result).toMatchObject({ ok: false, stage: "compile", code: "version-mismatch" });
  });

  it("rejects a syntax error at the compile stage", () => {
    const result = executeModelScriptVersioned("scene.box({ this is not valid", "woohaa-model-js-v2");
    expect(result).toMatchObject({ ok: false, stage: "compile" });
  });

  it("rejects a runtime error", () => {
    const result = executeModelScriptVersioned("throw new Error('boom');", "woohaa-model-js-v2");
    expect(result).toMatchObject({ ok: false, stage: "execute" });
  });

  it("rejects invalid Scene IR at the validate stage", () => {
    const result = executeModelScriptVersioned("scene.box({ id: 'b', color: 'not-a-color' });", "woohaa-model-js-v2");
    expect(result).toMatchObject({ ok: false, stage: "validate" });
  });

  it("detects non-deterministic scripts", () => {
    const result = executeModelScriptVersioned("scene.box({ id: 'b' + Math.random(), size: [1,1,1] });", "woohaa-model-js-v2");
    expect(result).toMatchObject({ ok: false, stage: "determinism" });
  });

  it("hashes stably", () => {
    expect(hashModelScript("abc")).toBe(hashModelScript("abc"));
    expect(hashModelScript("abc")).not.toBe(hashModelScript("abd"));
  });
});
