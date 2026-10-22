/**
 * React 编辑器进入判定的回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.3 / design D2/D7）。
 *
 * 重点是**纯媒体图片也要进入我们自己的编辑器**：这是图片编辑的常规入口，旧实现只在图片已
 * 携带工程定义时才进入，导致用户点图片编辑看到的还是旧标注界面。
 */
import { describe, expect, it } from "vitest";
import { decideEditorEntry } from "./editor-entry.js";

describe("decideEditorEntry", () => {
  it("纯媒体图片进入编辑器并以原图为背景层", () => {
    expect(decideEditorEntry({ hasProject: false, phase: "view", conversionFallback: false })).toEqual({ mode: "image" });
  });

  it("已有工程直接打开工程字节", () => {
    expect(decideEditorEntry({ hasProject: true, phase: "loading", conversionFallback: false })).toEqual({ mode: "project" });
    expect(decideEditorEntry({ hasProject: true, phase: "editing", conversionFallback: false })).toEqual({ mode: "project" });
  });

  it("旧标注转成每标注一层", () => {
    expect(decideEditorEntry({ hasProject: false, phase: "annotation", conversionFallback: false })).toEqual({ mode: "annotations" });
  });

  it("标注超出首期上限时回退旧标注界面（不压平标注）", () => {
    const entry = decideEditorEntry({ hasProject: false, phase: "annotation", conversionFallback: true });
    expect(entry.mode).toBe("none");
  });

  it("只读工程与错误态回退只读查看", () => {
    expect(decideEditorEntry({ hasProject: true, phase: "readonly-project", conversionFallback: false }).mode).toBe("none");
    expect(decideEditorEntry({ hasProject: true, phase: "error", conversionFallback: false }).mode).toBe("none");
    expect(decideEditorEntry({ hasProject: false, phase: "error", conversionFallback: false }).mode).toBe("none");
  });
});
