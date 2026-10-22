/**
 * React 编辑器的进入判定（纯函数）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.3 / design D2/D7）。
 *
 * 图片编辑的常规入口：**纯媒体图片也要进入我们自己的 React 编辑器**（以原图为背景层开新工程），
 * 而不是只有已保存过工程的图片才能进入。这里把判定抽成无 DOM 依赖的纯函数，便于回归；
 * 只读工程、错误态与「v1 转换超出首期上限」三种情况回退旧标注界面。
 */
import type { EditorSessionPhase } from "./session.js";

/** React 编辑器的进入方式。 */
export type EditorEntry =
  | { mode: "project" }
  | { mode: "image" }
  | { mode: "annotations" }
  | { mode: "none"; reason: string };

/**
 * 判定当前图片该以哪种方式进入 React 编辑器。
 *
 * - `project`：图片已携带工程定义，打开 `.pcraft` 字节；
 * - `image`：纯媒体图片，以原图为背景层开新工程；
 * - `annotations`：旧 v1 标注，先开新工程再把每条标注转成一个像素层；
 * - `none`：只读工程、错误态，或 v1 转换被首期上限拒绝 —— 由上层继续渲染旧标注界面。
 */
export function decideEditorEntry(input: {
  hasProject: boolean;
  phase: EditorSessionPhase;
  conversionFallback: boolean;
}): EditorEntry {
  if (input.phase === "readonly-project" || input.phase === "error") {
    return { mode: "none", reason: "工程不可编辑，仅可查看合成图" };
  }
  if (input.hasProject) return { mode: "project" };
  if (input.phase === "annotation") {
    // 超出首期上限时不静默压平：回退旧标注界面，保留原标注的可编辑性。
    if (input.conversionFallback) return { mode: "none", reason: "标注超出首期工程上限，保留旧标注编辑" };
    return { mode: "annotations" };
  }
  return { mode: "image" };
}
