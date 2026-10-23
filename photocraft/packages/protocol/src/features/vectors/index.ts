export const feature = {
  id: "vectors",
  capabilities: [
    { stage: "P7", order: 7, id: "vector.path" },
    { stage: "P7", order: 8, id: "vector.shape" },
    { stage: "P7", order: 9, id: "vector.mask" },
  ]
} as const;

/** 本域 wire 契约：形状参数与预设快照的有界解码（U08–U16）。 */
export {
  VECTOR_LIMITS,
  VECTOR_PATH_OPS,
  VECTOR_SHAPE_KINDS,
  decodeVectorShapeParams,
  decodeVectorShapePresetLibrary,
  vectorPathWithinBudget,
  vectorPresetSnapshotWithinBudget
} from "./params.js";
export type {
  VectorPathOp,
  VectorShapeKind,
  VectorShapeParams,
  VectorShapePresetEntry,
  VectorShapePresetLibrary
} from "./params.js";
