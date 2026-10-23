export const feature = {
  id: "channels",
  capabilities: [
    { stage: "P7", order: 38, id: "channel.panel" },
    { stage: "P7", order: 39, id: "channel.color-target" },
    { stage: "P7", order: 40, id: "channel.alpha" },
    { stage: "P7", order: 41, id: "channel.spot" },
    { stage: "P7", order: 42, id: "channel.split-merge" },
    { stage: "P7", order: 43, id: "channel.apply-image" },
    { stage: "P7", order: 44, id: "channel.calculations" },
    { stage: "P7", order: 45, id: "channel.luminosity-selection" },
  ]
} as const;
