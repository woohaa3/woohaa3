import { join } from "node:path";
import { expect, it } from "vitest";
import { frontendTarget } from "../../../../frontend-target.js";

// 断言里也要走 `join`：源码用 `node:path` 拼真实路径，Windows 下是反斜杠，写死 POSIX
// 分隔符会让这条用例只在类 Unix 上通过。
const ROOT = "/client/web/frontend";

it("desktop removes browser renderer from the build graph, browser keeps it", () => {
  const desktop = frontendTarget(ROOT, "desktop");
  expect(desktop.nativeOnly).toBe(true);
  expect(desktop.input).toEqual({ main: join(ROOT, "index.html") });
  const browser = frontendTarget(ROOT, "production");
  expect(browser.nativeOnly).toBe(false);
  expect(browser.input.renderer).toBe(join(ROOT, "renderer.html"));
});
