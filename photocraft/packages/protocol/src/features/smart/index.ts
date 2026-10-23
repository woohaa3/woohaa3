export const feature = {
  id: "smart",
  capabilities: [
    { stage: "P4", order: 0, id: "layer.smart-object" },
    { stage: "P4", order: 1, id: "layer.smart-object.child-document" },
    { stage: "P4", order: 2, id: "layer.smart-object.replace" },
    { stage: "P4", order: 3, id: "layer.smart-object.copy-independent" },
  ]
} as const;
