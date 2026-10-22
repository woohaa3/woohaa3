import { expect, it } from "vitest";
// @ts-expect-error Internal Node launcher has no TS declaration.
import { resolveModelRendererCommand } from "../../scripts/lib/model-renderer-command.mjs";

it.each([
  ["darwin", "arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "x86_64-apple-darwin"],
  ["linux", "x64", "x86_64-unknown-linux-gnu"]
])("discovers %s/%s renderer built by the native build script", (platform, arch, triple) => {
  const expected = `/repo/bevy/target/${triple}/release/model-renderer`;
  expect(resolveModelRendererCommand({root:"/repo",env:{},platform,arch,exists:(file:string)=>file===expected})).toBe(expected);
});
it("respects explicit configuration, custom native target and default cargo directories", () => {
  expect(resolveModelRendererCommand({root:"/repo",env:{WOOHAA3_MODEL_RENDERER_CMD:"/custom/renderer"},exists:()=>false})).toBe("/custom/renderer");
  expect(resolveModelRendererCommand({root:"/repo",env:{WOOHAA3_NATIVE_TARGET:"custom"},exists:(p:string)=>p==="/repo/bevy/target/custom/debug/model-renderer"})).toBe("/repo/bevy/target/custom/debug/model-renderer");
  expect(resolveModelRendererCommand({root:"/repo",env:{},exists:(p:string)=>p==="/repo/bevy/target/debug/model-renderer"})).toBe("/repo/bevy/target/debug/model-renderer");
  expect(resolveModelRendererCommand({root:"/repo",env:{},exists:()=>false})).toBeUndefined();
});
