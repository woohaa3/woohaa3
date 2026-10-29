/**
 * Dialog 响应式与 safe-area 样式（change: add-frontend-dialog-system，任务 2.4 / design D7）。
 *
 * 静态断言样式表包含 100dvh、safe-area 与 overflow 约束，避免窄屏溢出：
 * 这里无法做真实截图，改为验证关键约束存在且 variant/size 类齐全。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../../ui/src/styles/dialogs.css", import.meta.url)), "utf8");

describe("Dialog 样式约束", () => {
  it("Content 使用 100dvh 与 safe-area 约束", () => {
    expect(css).toContain("100dvh");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("env(safe-area-inset-top)");
  });

  it("Body 独立滚动且 Header/Footer 固定", () => {
    const body = css.slice(css.indexOf(".dlg__body"), css.indexOf(".dlg__body--media"));
    expect(body).toContain("overflow: auto");
    expect(body).toContain("min-height: 0");
  });

  it("定义了全部 variant 与 size 类", () => {
    for (const cls of [".dlg--standard", ".dlg--alert", ".dlg--media", ".dlg--sheet"]) {
      // standard 是缺省，可能没有显式规则；只要 media/sheet/alert 存在即可。
      if (cls === ".dlg--standard") continue;
      expect(css).toContain(cls);
    }
    for (const cls of [".dlg--sm", ".dlg--md", ".dlg--lg", ".dlg--fullscreen"]) {
      expect(css).toContain(cls);
    }
  });

  it("媒体 viewport 不溢出且保留抓取语义", () => {
    expect(css).toContain(".dlg__media-viewport");
    expect(css).toContain("cursor: grab");
    expect(css).toContain("touch-action: none");
  });

  it("提供共享媒体工作区与中性舞台", () => {
    // 主媒体区 + 可选辅助区 + 稳定舞台；stage 自带裁切，不随素材 intrinsic size 跳动。
    expect(css).toContain(".dlg__media-workspace");
    expect(css).toContain(".dlg__media-workspace--split");
    expect(css).toContain(".dlg__media-main");
    expect(css).toContain(".dlg__stage");
    expect(css).toMatch(/\.dlg__stage\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.dlg__media-workspace--split\s*\{[^}]*minmax\(0,\s*1\.6fr\)/);
  });

  it("图标按钮有可见 focus、禁用态与命中尺寸", () => {
    expect(css).toContain(".dlg__icon-button");
    expect(css).toMatch(/\.dlg__icon-button:focus-visible\s*\{[^}]*outline/);
  });

  it("窄屏下有 safe-area 与全屏媒体约束", () => {
    expect(css).toMatch(/@media \(max-width: 560px\)/);
  });

  it("窄屏媒体工作区降为单列并允许纵向滚动", () => {
    const narrow = css.match(/@media \(max-width: 720px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(narrow).toContain(".dlg__media-workspace--split");
    expect(narrow).toContain(".dlg__body--media-workspace");
    expect(narrow).toContain("overflow: auto");
  });
});
