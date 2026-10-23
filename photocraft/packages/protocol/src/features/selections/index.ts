export const feature = {
  id: "selections",
  capabilities: [
    { stage: "P0", order: 11, id: "selection.rect" },
    { stage: "P0", order: 12, id: "selection.lasso" },
    { stage: "P0", order: 13, id: "selection.feather" },
    { stage: "P0", order: 14, id: "mask.pixel" },
    { stage: "P5", order: 5, id: "selection.magic-wand" },
    { stage: "P5", order: 6, id: "selection.quick-select" },
    { stage: "P5", order: 7, id: "selection.color-range" },
    { stage: "P5", order: 8, id: "selection.modify" },
    { stage: "P5", order: 9, id: "selection.refine-edge" },
    { stage: "P7", order: 10, id: "selection.from-path" },
  ]
} as const;
