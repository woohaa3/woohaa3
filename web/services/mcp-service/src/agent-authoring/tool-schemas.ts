/**
 * Agent authoring 工具面：严格 zod input schema
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import { z } from "zod";
import { AGENT_SEMANTIC_KINDS } from "@woohaa3/contracts";

export const POSITION_SCHEMA = z.strictObject({ x: z.number(), y: z.number() });

export const SEMANTIC_KIND_TUPLE = AGENT_SEMANTIC_KINDS as unknown as ["text", "image", "model", "video", "audio"];

export const ENTITY_REF_SCHEMA = z.union([
  z.strictObject({ ref: z.string().min(1) }),
  z.strictObject({ nodeId: z.string().min(1) })
]);

export const PLACEMENT_SCHEMA = z.union([
  z.strictObject({ mode: z.literal("absolute"), position: POSITION_SCHEMA }),
  z.strictObject({ mode: z.literal("auto") }),
  z.strictObject({ mode: z.literal("after"), anchor: ENTITY_REF_SCHEMA, gap: z.number().nonnegative().optional() }),
  z.strictObject({ mode: z.literal("before"), anchor: ENTITY_REF_SCHEMA, gap: z.number().nonnegative().optional() }),
  z.strictObject({ mode: z.literal("below"), anchor: ENTITY_REF_SCHEMA, gap: z.number().nonnegative().optional() })
]);

export const PRECONDITION_SCHEMA = z.union([
  z.strictObject({ type: z.literal("node-exists"), nodeId: z.string().min(1) }),
  z.strictObject({ type: z.literal("node-missing"), nodeId: z.string().min(1) }),
  z.strictObject({ type: z.literal("prompt-equals"), nodeId: z.string().min(1), equals: z.string() }),
  z.strictObject({ type: z.literal("not-processing"), nodeId: z.string().min(1) })
]);

export const OPERATION_SCHEMA = z.union([
  z.strictObject({
    op: z.literal("create_node"),
    ref: z.string().min(1),
    kind: z.enum(SEMANTIC_KIND_TUPLE),
    title: z.string().optional(),
    prompt: z.string().optional(),
    placement: PLACEMENT_SCHEMA.optional()
  }),
  z.strictObject({
    op: z.literal("connect"),
    ref: z.string().min(1),
    from: ENTITY_REF_SCHEMA,
    to: ENTITY_REF_SCHEMA,
    label: z.string().optional(),
    if: PRECONDITION_SCHEMA.optional()
  }),
  z.strictObject({
    op: z.literal("set_prompt"),
    target: ENTITY_REF_SCHEMA,
    prompt: z.string(),
    if: PRECONDITION_SCHEMA.optional()
  }),
  z.strictObject({
    op: z.literal("move_node"),
    target: ENTITY_REF_SCHEMA,
    position: POSITION_SCHEMA,
    if: PRECONDITION_SCHEMA.optional()
  }),
  z.strictObject({
    op: z.literal("resize_node"),
    target: ENTITY_REF_SCHEMA,
    size: z.strictObject({ width: z.number().positive(), height: z.number().positive() }),
    if: PRECONDITION_SCHEMA.optional()
  }),
  z.strictObject({
    op: z.literal("delete"),
    targets: z.array(ENTITY_REF_SCHEMA).min(1),
    if: PRECONDITION_SCHEMA.optional()
  })
]);

export const CANVAS_ID_SCHEMA = { canvasId: z.string().min(1) } as const;
