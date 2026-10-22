/**
 * 前端构建标识的归一与兜底。
 *
 * 单测里没有 vite 的 `define`（只有打包/调试时才做文本替换），注入值以全局属性形式模拟——
 * 与 `typeof` 守卫的读取路径等价。守两件事：
 * - 优先短提交号（管理端拿它和服务端 `GetServerInfo.commit` 对照）；
 * - 非法/超长/空值不能进入上报链路（服务端会丢弃，但没必要把噪声发过去）。
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { appBuildVersion } from "./build-info.js";

const VERSION_KEY = "__WOOHAA_FRONTEND_BUILD_VERSION__";
const COMMIT_KEY = "__WOOHAA_FRONTEND_BUILD_COMMIT__";
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete globals[VERSION_KEY];
  delete globals[COMMIT_KEY];
});

describe("前端构建标识", () => {
  it("未注入时返回空串，而不是编一个版本", () => {
    expect(appBuildVersion()).toBe("");
  });

  it("优先短提交号：它才能与服务端 commit 直接对照", () => {
    globals[COMMIT_KEY] = "abc1234";
    globals[VERSION_KEY] = "v1.2.3-4-gabc1234";
    expect(appBuildVersion()).toBe("abc1234");
  });

  it("没有提交号时退回版本串（tags 缺失/仓库外构建）", () => {
    globals[VERSION_KEY] = "v1.2.3-4-gabc1234-dirty";
    expect(appBuildVersion()).toBe("v1.2.3-4-gabc1234-dirty");
  });

  it("非法形状或超长值不进入上报", () => {
    globals[COMMIT_KEY] = "abc 1234";
    globals[VERSION_KEY] = "x".repeat(65);
    expect(appBuildVersion()).toBe("");
  });
});
