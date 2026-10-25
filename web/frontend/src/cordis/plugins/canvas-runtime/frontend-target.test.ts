import { expect, it } from "vitest";
import { frontendTarget } from "../../../../frontend-target.js";

it("desktop removes browser renderer from the build graph, browser keeps it", () => {
  const desktop = frontendTarget("/client/web/frontend", "desktop");
  expect(desktop.nativeOnly).toBe(true);
  expect(desktop.input).toEqual({ main: "/client/web/frontend/index.html" });
  const browser = frontendTarget("/client/web/frontend", "production");
  expect(browser.nativeOnly).toBe(false);
  expect(browser.input.renderer).toBe("/client/web/frontend/renderer.html");
});
