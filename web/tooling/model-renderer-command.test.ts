import path from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Internal Node launcher has no TS declaration.
import { resolveModelRendererCommand } from "../../scripts/lib/model-renderer-command.mjs";

/**
 * 期望值一律用 `path.join` 拼：实现走的是同一套 path 语义，
 * 在 Windows 上分隔符是反斜杠、二进制名带 `.exe`，写死 POSIX 路径必挂。
 */
const expected = (...parts: string[]) => path.join(...parts);

it.each([
  ["darwin", "arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "x86_64-apple-darwin"],
  ["linux", "x64", "x86_64-unknown-linux-gnu"]
])("discovers %s/%s renderer built by the native build script", (platform, arch, triple) => {
  const binary = platform === "win32" ? "model-renderer.exe" : "model-renderer";
  const target = expected("/repo", "bevy", "target", triple, "release", binary);
  expect(resolveModelRendererCommand({ root: "/repo", env: {}, platform, arch, exists: (file: string) => file === target })).toBe(target);
});

it("respects explicit configuration, custom native target and default cargo directories", () => {
  // 这组不传 platform，实现会按 `process.platform` 决定二进制名（Windows 带 `.exe`）。
  const binary = process.platform === "win32" ? "model-renderer.exe" : "model-renderer";
  expect(resolveModelRendererCommand({ root: "/repo", env: { WOOHAA3_MODEL_RENDERER_CMD: "/custom/renderer" }, exists: () => false })).toBe("/custom/renderer");
  const custom = expected("/repo", "bevy", "target", "custom", "debug", binary);
  expect(resolveModelRendererCommand({ root: "/repo", env: { WOOHAA3_NATIVE_TARGET: "custom" }, exists: (p: string) => p === custom })).toBe(custom);
  const plain = expected("/repo", "bevy", "target", "debug", binary);
  expect(resolveModelRendererCommand({ root: "/repo", env: {}, exists: (p: string) => p === plain })).toBe(plain);
  expect(resolveModelRendererCommand({ root: "/repo", env: {}, exists: () => false })).toBeUndefined();
});
