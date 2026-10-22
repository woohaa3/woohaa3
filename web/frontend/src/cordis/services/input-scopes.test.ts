/**
 * Input Scope Service 测试（change: adopt-frontend-cordis-plugin-runtime，design D3）。
 *
 * 覆盖：门禁注册/撤销、scope 隔离、blocksCanvas 聚合，dispose 后回到零门禁。
 */
import { describe, expect, it } from "vitest";
import { InputScopeService } from "./input-scopes.js";

describe("InputScopeService", () => {
  it("默认不阻断画布", () => {
    const scopes = new InputScopeService();
    expect(scopes.blocksCanvas()).toBe(false);
    expect(scopes.isActive("modal")).toBe(false);
  });

  it("modal 门禁激活时阻断画布", () => {
    const scopes = new InputScopeService();
    let modal = false;
    const dispose = scopes.addScope("modal", () => modal);
    expect(scopes.blocksCanvas()).toBe(false);
    modal = true;
    expect(scopes.isActive("modal")).toBe(true);
    expect(scopes.blocksCanvas()).toBe(true);
    dispose();
    expect(scopes.blocksCanvas()).toBe(false);
  });

  it("menu/editor scope 也阻断画布，且互不串用", () => {
    const scopes = new InputScopeService();
    const disposeMenu = scopes.addScope("menu", () => true);
    expect(scopes.isActive("menu")).toBe(true);
    expect(scopes.isActive("modal")).toBe(false);
    expect(scopes.blocksCanvas()).toBe(true);
    disposeMenu();
    scopes.addScope("editor", () => true);
    expect(scopes.isActive("editor")).toBe(true);
    expect(scopes.isActive("menu")).toBe(false);
  });

  it("多个门禁任一为 true 即阻断，全部撤销后恢复", () => {
    const scopes = new InputScopeService();
    const d1 = scopes.addScope("modal", () => false);
    const d2 = scopes.addScope("modal", () => true);
    expect(scopes.blocksCanvas()).toBe(true);
    d2();
    expect(scopes.blocksCanvas()).toBe(false);
    d1();
    expect(scopes.blocksCanvas()).toBe(false);
  });

  it("blocksFocusInput 只在真正 modal 激活时为 true（change: fix-model-focus-navigation-and-camera-parity，design D6）", () => {
    const scopes = new InputScopeService();
    expect(scopes.blocksFocusInput()).toBe(false);
    const removeMenu = scopes.addScope("menu", () => true);
    const removeEditor = scopes.addScope("editor", () => true);
    // 非模态 menu/editor 阻断 2D 画布，但不阻断聚焦相机输入。
    expect(scopes.blocksCanvas()).toBe(true);
    expect(scopes.blocksFocusInput()).toBe(false);
    const removeModal = scopes.addGate(() => true);
    expect(scopes.blocksFocusInput()).toBe(true);
    removeModal();
    removeMenu();
    removeEditor();
    expect(scopes.blocksFocusInput()).toBe(false);
  });
});
