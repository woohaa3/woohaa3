/**
 * 片段正文 token codec 与 materialization
 * （change: add-prompt-snippet-library，任务 3.1/3.2/3.5 / design D3/D5）。
 *
 * 复用节点 mention 的**词法**结构 `{{input_*:identity:label}}`，但 identity 字段解释为
 * 片段局部 `materialKey`，而非画布 input `slotId`。本模块是纯函数：
 * - `captureNodePromptAsSnippetBody`：把节点 slot token 重写为 material key；
 * - `validateSnippetBodyMaterials`：正文 ↔ materials 双向一致性；
 * - `materializeSnippetBody`：按目标节点已有合法 direct mapping 把局部 token 转回 slot token，
 *   否则降级为可读 `@label` 文本。
 */
import {
  collectWoohaa3CanvasMentions,
  extractWoohaa3CanvasMentions,
  isWoohaa3CanvasMentionType,
  serializeWoohaa3CanvasMention,
  type Woohaa3CanvasMention,
  type Woohaa3CanvasMentionType
} from "../canvas/domain/core/mention-token.js";
import type { PromptSnippetMaterial } from "./dto.js";

/** mention 类型 ↔ material media kind 兼容关系。 */
export function mentionTypeForMediaKind(kind: PromptSnippetMaterial["mediaKind"]): Woohaa3CanvasMentionType {
  if (kind === "image") return "input_image";
  if (kind === "video") return "input_video";
  if (kind === "audio") return "input_audio";
  return "input_text";
}

export function mediaKindForMentionType(type: Woohaa3CanvasMentionType): PromptSnippetMaterial["mediaKind"] {
  if (type === "input_image") return "image";
  if (type === "input_video") return "video";
  if (type === "input_audio") return "audio";
  return "text";
}

/** 捕获时的 slot 身份与生成的局部 key 的映射。 */
export type CapturedMaterial = {
  /** 生成的片段局部 key（`material-1`...）。 */
  materialKey: string;
  mention: Woohaa3CanvasMention;
};

export type CaptureResult = {
  body: string;
  materials: CapturedMaterial[];
  /** 无法权威解析的 slot token 数量（阻止保存时可诊断）。 */
  unresolved: Woohaa3CanvasMention[];
};

/**
 * 把节点 prompt 中的合法 slot token 重写为片段局部 material key。
 *
 * `resolveSlot` 返回该 slot 当前的 material 描述；返回 null 表示无法权威解析（失效/未就绪）。
 * 普通文本与未 token 化的 `@文字` 原样保留。
 */
export function captureNodePromptAsSnippetBody(input: {
  prompt: string;
  resolveSlot: (slotId: string) => Omit<PromptSnippetMaterial, "key"> | null;
}): CaptureResult {
  const segments = extractWoohaa3CanvasMentions(input.prompt);
  const materials: CapturedMaterial[] = [];
  const unresolved: Woohaa3CanvasMention[] = [];
  const bySlot = new Map<string, string>();
  let output = "";
  let ordinal = 0;

  for (const segment of segments) {
    if (segment.kind === "text") {
      output += segment.text;
      continue;
    }
    const { mention } = segment;
    const existing = bySlot.get(mention.slotId);
    if (existing) {
      output += rewrite(mention, existing);
      continue;
    }
    const material = input.resolveSlot(mention.slotId);
    if (!material || material.mediaKind !== mediaKindForMentionType(mention.type)) {
      unresolved.push(mention);
      output += `@${mention.label}`;
      continue;
    }
    ordinal += 1;
    const materialKey = `material-${ordinal}`;
    bySlot.set(mention.slotId, materialKey);
    materials.push({ materialKey, mention });
    output += rewrite(mention, materialKey);
  }
  return { body: output, materials, unresolved };
}

function rewrite(mention: Woohaa3CanvasMention, materialKey: string): string {
  return serializeWoohaa3CanvasMention({ type: mention.type, slotId: materialKey, label: mention.label }) ?? `@${mention.label}`;
}

export type SnippetBodyValidation =
  | { ok: true }
  | { ok: false; code: "SNIPPET_INVALID"; message: string };

/**
 * 双向一致性校验：
 * - 每个 token 必须有同类型 material；
 * - 每个 material 必须被正文引用且仅引用一次；
 * - material key 唯一且不重复。
 */
export function validateSnippetBodyMaterials(body: string, materials: readonly PromptSnippetMaterial[]): SnippetBodyValidation {
  const keys = new Set<string>();
  for (const material of materials) {
    if (keys.has(material.key)) return invalid(`material key 重复：${material.key}`);
    keys.add(material.key);
  }
  const byKey = new Map(materials.map((material) => [material.key, material]));
  const referenced = new Set<string>();
  for (const mention of collectWoohaa3CanvasMentions(body)) {
    const material = byKey.get(mention.slotId);
    if (!material) return invalid(`正文引用了不存在的 material：${mention.slotId}`);
    if (material.mediaKind !== mediaKindForMentionType(mention.type)) {
      return invalid(`token 类型 ${mention.type} 与 material ${material.key} 的 ${material.mediaKind} 不匹配`);
    }
    if (referenced.has(mention.slotId)) return invalid(`material ${mention.slotId} 被引用多次`);
    referenced.add(mention.slotId);
  }
  for (const material of materials) {
    if (!referenced.has(material.key)) return invalid(`material ${material.key} 未被正文引用`);
  }
  return { ok: true };
}

function invalid(message: string): { ok: false; code: "SNIPPET_INVALID"; message: string } {
  return { ok: false, code: "SNIPPET_INVALID", message };
}

/** 目标节点可用的 direct input mapping（应用期 materialization 用）。 */
export type TargetInputMapping = {
  slotId: string;
  role: string;
  /** 稳定素材身份（assetId + storageKey/checksum）。 */
  assetId: string;
  storageKey?: string;
  checksum?: string;
  contentKind: PromptSnippetMaterial["mediaKind"];
};

export type MaterializationDiagnostic = {
  materialKey: string;
  label: string;
  reason: "not-found" | "unresolved" | "type-mismatch";
};

export type MaterializationResult = {
  body: string;
  diagnostics: MaterializationDiagnostic[];
};

/**
 * 应用片段正文到目标节点草稿。
 *
 * 对每个局部 material token：
 * 1. 目标存在类型匹配且稳定身份相同的 mapping → 转为该 mapping 的规范 slot token；
 * 2. 否则降级为可读 `@label`，并产生非阻断诊断；
 * 3. 不创建 edge/asset/mapping，也不生成虚拟 input。
 */
export function materializeSnippetBody(input: {
  body: string;
  materials: readonly PromptSnippetMaterial[];
  targetMappings: readonly TargetInputMapping[];
}): MaterializationResult {
  const byKey = new Map(input.materials.map((material) => [material.key, material]));
  const diagnostics: MaterializationDiagnostic[] = [];
  const segments = extractWoohaa3CanvasMentions(input.body);
  let output = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      output += segment.text;
      continue;
    }
    const { mention } = segment;
    const material = byKey.get(mention.slotId);
    if (!material) {
      output += `@${mention.label}`;
      diagnostics.push({ materialKey: mention.slotId, label: mention.label, reason: "not-found" });
      continue;
    }
    if (!isWoohaa3CanvasMentionType(mention.type)) {
      output += `@${mention.label}`;
      diagnostics.push({ materialKey: mention.slotId, label: mention.label, reason: "type-mismatch" });
      continue;
    }
    const mapping = findMatchingMapping(material, input.targetMappings);
    if (!mapping) {
      output += `@${mention.label}`;
      diagnostics.push({ materialKey: mention.slotId, label: mention.label, reason: "unresolved" });
      continue;
    }
    output += serializeWoohaa3CanvasMention({ type: mention.type, slotId: mapping.slotId, label: mention.label }) ?? `@${mention.label}`;
  }
  return { body: output, diagnostics };
}

function findMatchingMapping(
  material: PromptSnippetMaterial,
  mappings: readonly TargetInputMapping[]
): TargetInputMapping | null {
  for (const mapping of mappings) {
    if (mapping.contentKind !== material.mediaKind) continue;
    if (mapping.assetId !== material.assetId) continue;
    // 稳定身份：storageKey 优先，其次 checksum；文本 material 只比对 assetId。
    if (material.mediaKind === "text") return mapping;
    if (typeof material.storageKey === "string") {
      if (mapping.storageKey === material.storageKey) return mapping;
      continue;
    }
    if (mapping.checksum === material.checksum) return mapping;
  }
  return null;
}

/** 供编辑期维护 materials 清单：返回被正文引用的 key 集合。 */
export function referencedMaterialKeys(body: string): Set<string> {
  return new Set(collectWoohaa3CanvasMentions(body).map((mention) => mention.slotId));
}
