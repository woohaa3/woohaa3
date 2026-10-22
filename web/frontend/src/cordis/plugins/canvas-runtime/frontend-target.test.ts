import { expect, it } from "vitest";
import { externalizeEditorWasm, frontendTarget } from "../../../../frontend-target.js";

it("desktop removes browser renderer from the build graph, browser keeps it", () => {
  const desktop = frontendTarget("/client/web/frontend", "desktop");
  expect(desktop.nativeOnly).toBe(true);
  expect(desktop.input).toEqual({ main: "/client/web/frontend/index.html" });
  const browser = frontendTarget("/client/web/frontend", "production");
  expect(browser.nativeOnly).toBe(false);
  expect(browser.input.renderer).toBe("/client/web/frontend/renderer.html");
});

it("desktop editor requests a managed local asset and offers guidance without downloading", () => {
  const output = externalizeEditorWasm("module_or_path = new URL('./photocraft_editor_bg.wasm', import.meta.url);");
  expect(output).not.toContain("new URL('./photocraft_editor_bg.wasm'");
  expect(output).toContain("/api/runtime-components/image-editor/asset");
  expect(output).toContain("woohaa-runtime-component-required");
  expect(output).not.toContain("/install");
  expect(() => externalizeEditorWasm("changed upstream glue")).toThrow("入口已变化");
});
