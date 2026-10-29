import { filmSetPresentationPrimitives, type ContentPresentationAdapter } from "@woohaa3/contracts";

/**
 * 片场内容呈现 adapter（change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
 *
 * 宿主只把权威画布、本地呈现态与相机锚点投影交给 adapter；片场自己的镜头/绑定语义在这里
 * 投影为通用 `previewCards` / `ownershipLinks` 原语。渲染层（Bevy/Rust）不读取任何片场字段。
 */
export const filmSetPresentation: ContentPresentationAdapter = {
  presentPrimitives(context) {
    return filmSetPresentationPrimitives({
      canvas: context.canvas,
      ...(context.localStates ? { localStates: context.localStates } : {}),
      ...(context.projectEntityAnchor ? { projectEntityAnchor: context.projectEntityAnchor } : {})
    });
  }
};
