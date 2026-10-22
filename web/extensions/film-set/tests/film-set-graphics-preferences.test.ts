/**
 * 导出 profile 本地偏好与动画示例（change: 2026-10-19-extend-film-set-for-motion-graphics，D7/6.1）。
 */
import { describe, expect, it, vi } from "vitest";
import { MOTION_GRAPHICS_SHOWCASE, MOTION_GRAPHICS_SHOWCASE_TEXT, motionApiGuideText } from "@woohaa3/contracts";
import {
  EXPORT_PROFILE_OPTIONS,
  EXPORT_PROFILE_STORAGE_KEY,
  readExportProfilePreference,
  writeExportProfilePreference
} from "../src/authoring/browser/film-set-export-profile-preference.js";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
  };
}

describe("导出 profile 本地偏好（D7）", () => {
  it("缺省 standard，合法值原样读回", () => {
    expect(readExportProfilePreference(storage())).toBe("standard");
    expect(readExportProfilePreference(storage({ [EXPORT_PROFILE_STORAGE_KEY]: "hd60" }))).toBe("hd60");
    expect(readExportProfilePreference(storage({ [EXPORT_PROFILE_STORAGE_KEY]: "4k" }))).toBe("standard");
  });

  it("写入成功返回档位；存储不可用时不抛错、仍返回档位", () => {
    const store = storage();
    expect(writeExportProfilePreference("hd", store)).toBe("hd");
    expect(store.setItem).toHaveBeenCalledWith(EXPORT_PROFILE_STORAGE_KEY, "hd");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readExportProfilePreference(broken)).toBe("standard");
    expect(writeExportProfilePreference("hd60", broken)).toBe("hd60");
  });

  it("选择器覆盖三种档位且标明缺省项", () => {
    expect(EXPORT_PROFILE_OPTIONS.map(option => option.value)).toEqual(["standard", "hd", "hd60"]);
    expect(EXPORT_PROFILE_OPTIONS[0]!.label).toContain("缺省");
  });
});

describe("宣传动效范例（6.1）", () => {
  it("对象脚本包含淡入、0.6→1.08→1 弹出与连线伸长", () => {
    const script = MOTION_GRAPHICS_SHOWCASE.objectScript;
    expect(script).toContain('property: "opacity"');
    expect(script).toContain("0.6, 0.6, 0.6");
    expect(script).toContain("1.08, 1.08, 1.08");
    expect(script).toContain('"connector"');
    expect(script).toContain('easing: "easeOut"');
  });

  it("镜头脚本用 easeOut 推近，且与对象脚本分开写", () => {
    expect(MOTION_GRAPHICS_SHOWCASE.cameraScript).toContain("motion.camera.tween");
    expect(MOTION_GRAPHICS_SHOWCASE.cameraScript).toContain('easing: "easeOut"');
    expect(MOTION_GRAPHICS_SHOWCASE.cameraScript).not.toContain("motion.model.");
  });

  it("指南文本包含范例与透明度/缓动说明", () => {
    const guide = motionApiGuideText();
    expect(guide).toContain("宣传动效示例");
    expect(guide).toContain(MOTION_GRAPHICS_SHOWCASE_TEXT);
    expect(guide).toContain("easeInOut");
    expect(guide).toContain("opacity");
  });
});
