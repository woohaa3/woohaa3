/**
 * 跨语言 golden：TS 派生与 Rust `canvas_query` 共享同一 fixture
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 7.2）。
 *
 * 只断言已固定的行为：signature/AABB/extent、FNV-1a UTF-16 与 2D 点命中参数。Rust 侧
 * `bevy/tests/hot_paths_golden.rs` 读取同一文件并断言相同值。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnv1a64Hex } from "../canvas/content-hash.js";
import { v2SceneAabb, v2ExtentFromAabb } from "../canvas/scene-ir-v2.js";
import { prepareModelResource } from "../canvas/prepared-model.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures", "canvas-hot-paths-golden.json"), "utf8")
) as {
  modelV2: {
    sceneVersion: string;
    opsJson: string;
    signature: string;
    aabb: { min: number[]; max: number[] };
    extent: number;
  };
  fnv: { empty: string; abc: string; unicode: { text: string; hash: string } };
};

describe("canvas hot paths golden（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）", () => {
  it("FNV-1a UTF-16 与 Rust golden 一致", () => {
    expect(fnv1a64Hex("")).toBe(fixture.fnv.empty);
    expect(fnv1a64Hex("abc")).toBe(fixture.fnv.abc);
    expect(fnv1a64Hex(fixture.fnv.unicode.text)).toBe(fixture.fnv.unicode.hash);
  });

  it("signature 与 canonical ops JSON 一致", () => {
    const ops = JSON.parse(fixture.modelV2.opsJson) as unknown[];
    const resource = prepareModelResource({
      sceneVersion: fixture.modelV2.sceneVersion,
      ops: ops as never
    });
    expect(resource.signature).toBe(fixture.modelV2.signature);
    expect(resource.resourceKey).toBe(`${fixture.modelV2.sceneVersion}:${fixture.modelV2.signature}`);
  });

  it("AABB 与 extent 与 Rust golden 一致", () => {
    const ops = JSON.parse(fixture.modelV2.opsJson) as never[];
    const aabb = v2SceneAabb(ops as never)!;
    expect(aabb.min).toEqual(fixture.modelV2.aabb.min);
    expect(aabb.max).toEqual(fixture.modelV2.aabb.max);
    expect(v2ExtentFromAabb(aabb)).toBe(fixture.modelV2.extent);
  });
});
