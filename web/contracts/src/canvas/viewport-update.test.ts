/**
 * 视口增量 wire 协议（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
 *
 * 断言固定大小、camelCase 键、有限值规范化与 zoom clamp；版本与 Rust
 * `bevy/src/protocol/viewport.rs` 的 `CANVAS_VIEWPORT_UPDATE_VERSION` 逐字节一致。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANVAS_VIEWPORT_UPDATE_VERSION,
  canvasViewportUpdateRequest,
  normalizeViewportUpdate
} from "./viewport-update.js";
import { WOOHAA3_CANVAS_MAX_ZOOM, WOOHAA3_CANVAS_MIN_ZOOM } from "./domain/core/viewport-zoom.js";

describe("viewport update wire（design D3）", () => {
  it("编码固定大小请求：只含 version/baseSceneGeneration/viewport", () => {
    const json = canvasViewportUpdateRequest({ baseSceneGeneration: 7, viewport: { x: 10, y: 20, zoom: 1.5 } });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(["baseSceneGeneration", "version", "viewport"]);
    expect(parsed.version).toBe(CANVAS_VIEWPORT_UPDATE_VERSION);
    expect(parsed.baseSceneGeneration).toBe(7);
    expect(parsed.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it("payload 大小不随任何全场规模字段变化（固定大小）", () => {
    const a = canvasViewportUpdateRequest({ baseSceneGeneration: 1, viewport: { x: 0, y: 0, zoom: 1 } });
    const b = canvasViewportUpdateRequest({ baseSceneGeneration: 999999, viewport: { x: -12345.678, y: 98765.4, zoom: 3.25 } });
    // 请求结构固定；数值差异只影响文本长度，不含节点/边/模型。
    expect(a).not.toContain("nodes");
    expect(a).not.toContain("edges");
    expect(b).not.toContain("nodes");
    expect(b).not.toContain("edges");
  });

  it("规范化非有限值为 0 并 clamp zoom 到共享区间", () => {
    expect(normalizeViewportUpdate({ x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: 1 })).toEqual({ x: 0, y: 0, zoom: 1 });
    const clamped = normalizeViewportUpdate({ x: 0, y: 0, zoom: 1000 });
    expect(clamped.zoom).toBe(WOOHAA3_CANVAS_MAX_ZOOM);
    expect(normalizeViewportUpdate({ x: 0, y: 0, zoom: 0 }).zoom).toBe(WOOHAA3_CANVAS_MIN_ZOOM);
  });

  it("baseSceneGeneration 规范化为非负整数", () => {
    expect(JSON.parse(canvasViewportUpdateRequest({ baseSceneGeneration: -5, viewport: { x: 0, y: 0, zoom: 1 } })).baseSceneGeneration).toBe(0);
    expect(JSON.parse(canvasViewportUpdateRequest({ baseSceneGeneration: 3.9, viewport: { x: 0, y: 0, zoom: 1 } })).baseSceneGeneration).toBe(3);
  });

  it("版本字符串与 Rust protocol/viewport.rs 一致（不得静默分叉）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/protocol/viewport.rs"), "utf8");
    const match = rust.match(/CANVAS_VIEWPORT_UPDATE_VERSION: &str = "([^"]+)"/);
    expect(match, "bevy 缺少 CANVAS_VIEWPORT_UPDATE_VERSION").toBeTruthy();
    expect(match![1]).toBe(CANVAS_VIEWPORT_UPDATE_VERSION);
  });

  it("zoom 校验区间与 Rust viewport.rs 一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/protocol/viewport.rs"), "utf8");
    const match = rust.match(/const MIN_ZOOM: f32 = ([\d.]+);[\s\S]*?const MAX_ZOOM: f32 = ([\d.]+);/);
    expect(match, "bevy 缺少 MIN_ZOOM/MAX_ZOOM").toBeTruthy();
    expect(Number(match![1])).toBe(WOOHAA3_CANVAS_MIN_ZOOM);
    expect(Number(match![2])).toBe(WOOHAA3_CANVAS_MAX_ZOOM);
  });
});
