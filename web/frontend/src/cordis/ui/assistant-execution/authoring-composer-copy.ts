/**
 * 创作入口的标题/占位/按钮文案（从 `authoring-composer.tsx` 的 `target` 字面量原样移出）。
 *
 * 移出原因只是 file-budget：`authoring-composer.tsx` 曾越过 800 物理行上限。这里是纯文案表，
 * 按模式与是否 inspector 取一组固定字符串，不含任何状态。
 */
import type { AuthoringGenerationProps } from "../../contract/authoring.js";

export type AuthoringComposerCopy = {
  title: string;
  placeholder: string;
  action: string;
};

export function authoringComposerCopy(
  mode: AuthoringGenerationProps["mode"],
  input: { inspector: boolean; worldCamera?: boolean },
): AuthoringComposerCopy {
  const { inspector, worldCamera } = input;
  return worldCamera
    ? {
        title: "调整镜头",
        placeholder:
          "描述构图、视角或镜头运动，例如：缓慢环绕主体，保持低机位…",
        action: "调整镜头",
      }
    : mode === "canvas-group"
        ? {
            title: "生成组",
            placeholder:
              "描述组内要搭建或调整的内容，例如：生成分镜、补齐图片和视频，保留已完成结果…",
            action: "生成",
          }
        : mode === "text"
          ? {
              title: "生成文本",
              placeholder: "描述要生成的文字，或引用上游内容…",
              action: "生成",
            }
          : {
              title: inspector ? "AI 修改" : "生成 3D 模型",
              placeholder: inspector
                ? "描述想修改的部分，例如：把灯罩改成磨砂金属，保留支架造型…"
                : "描述形状、材质和细节，例如：一盏磨砂金属台灯，圆形灯罩，细长支架…",
              action: inspector ? "修改模型" : "生成",
            };
}
