/**
 * 原生录制能力探测（任务 7.3）。
 *
 * 关键约束：**不静默回退**、**不误导用户换浏览器**、浏览器版不假装支持宿主录制。
 */
import { describe, expect, it } from "vitest";
import { isDesktopShell, nativeRecordingAvailable } from "../src/frontend/native-recording-availability.js";
import type {} from "../src/frontend/native-recording-availability.js";

describe("isDesktopShell", () => {
  it("detects the native bridge", () => {
    expect(isDesktopShell({ nativeBridge: { token: "x" } })).toBe(true);
  });

  it("falls back to the desktop user agent", () => {
    expect(isDesktopShell({ userAgent: "Mozilla/5.0 woohaa-desktop/0.1" })).toBe(true);
    expect(isDesktopShell({ userAgent: "Mozilla/5.0 Chrome/130" })).toBe(false);
  });

  it("treats a bare environment as browser-only", () => {
    expect(isDesktopShell({})).toBe(false);
  });
});

describe("nativeRecordingAvailable", () => {
  it("uses the host path in the desktop shell", () => {
    expect(nativeRecordingAvailable({ nativeBridge: {} })).toBe(true);
  });

  it("keeps the browser adapter outside the desktop shell", () => {
    expect(nativeRecordingAvailable({ userAgent: "Mozilla/5.0 Chrome/130" })).toBe(false);
  });

  it("can be turned off explicitly for troubleshooting", () => {
    // `__WOOHAA_NATIVE_RECORDING__ = false` 由宿主注入时强制走浏览器适配器。
    const original = (globalThis as { __WOOHAA_NATIVE_RECORDING__?: unknown }).__WOOHAA_NATIVE_RECORDING__;
    (globalThis as { __WOOHAA_NATIVE_RECORDING__?: unknown }).__WOOHAA_NATIVE_RECORDING__ = false;
    try {
      expect(nativeRecordingAvailable()).toBe(false);
    } finally {
      if (original === undefined) {
        delete (globalThis as { __WOOHAA_NATIVE_RECORDING__?: unknown }).__WOOHAA_NATIVE_RECORDING__;
      } else {
        (globalThis as { __WOOHAA_NATIVE_RECORDING__?: unknown }).__WOOHAA_NATIVE_RECORDING__ = original;
      }
    }
  });
});
