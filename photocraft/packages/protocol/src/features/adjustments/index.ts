export const feature = {
  id: "adjustments",
  capabilities: [
    { stage: "P0", order: 18, id: "adjust.brightness-contrast" },
    { stage: "P0", order: 19, id: "adjust.hue-saturation" },
    { stage: "P0", order: 20, id: "adjust.curves" },
    { stage: "P5", order: 0, id: "adjust.levels" },
    { stage: "P5", order: 1, id: "adjust.channel-curves" },
    { stage: "P5", order: 2, id: "adjust.vibrance" },
    { stage: "P5", order: 3, id: "adjust.black-white" },
    { stage: "P5", order: 4, id: "analysis.histogram" },
    // U41/U42 的高级持久选项（输出端点、铅笔/平滑、六色域、Tint）。
    { stage: "P5", order: 10, id: "adjust.levels-output" },
    { stage: "P5", order: 11, id: "adjust.curve-pencil" },
    { stage: "P5", order: 12, id: "adjust.hue-ranges" },
    { stage: "P5", order: 13, id: "adjust.black-white-tint" },
    // U43：九类新增逐类调整（直接调整 + 调整层）。
    { stage: "P5", order: 14, id: "adjust.exposure" },
    { stage: "P5", order: 15, id: "adjust.color-balance" },
    { stage: "P5", order: 16, id: "adjust.photo-filter" },
    { stage: "P5", order: 17, id: "adjust.channel-mixer" },
    { stage: "P5", order: 18, id: "adjust.invert" },
    { stage: "P5", order: 19, id: "adjust.posterize" },
    { stage: "P5", order: 20, id: "adjust.threshold" },
    { stage: "P5", order: 21, id: "adjust.gradient-map" },
    { stage: "P5", order: 22, id: "adjust.selective-color" },
    // U44：自动校正与匹配/替换颜色。
    { stage: "P5", order: 23, id: "adjust.auto-tone" },
    { stage: "P5", order: 24, id: "adjust.auto-contrast" },
    { stage: "P5", order: 25, id: "adjust.auto-color" },
    { stage: "P5", order: 26, id: "adjust.desaturate" },
    { stage: "P5", order: 27, id: "adjust.equalize" },
    { stage: "P5", order: 28, id: "adjust.shadows-highlights" },
    { stage: "P5", order: 29, id: "adjust.replace-color" },
    { stage: "P5", order: 30, id: "adjust.match-color" },
  ]
} as const;
