export const feature = {
  id: "views",
  capabilities: [
    { stage: "P7", order: 3, id: "view.guides" },
    { stage: "P7", order: 4, id: "view.grid-snap" },
    // 逐项工作流接通后开放（U71/U73）；`view.rotate-navigator` 仍关闭（旋转的像素呈现缺宿主端口）。
    { stage: "P7", order: 11, id: "view.guide-layout" },
    { stage: "P7", order: 12, id: "view.analysis" },
  ]
} as const;
