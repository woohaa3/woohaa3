/**
 * Mention 编辑器 <-> token string 桥接
 * （change: add-reference-inputs-and-mentions，任务 4.1 / 4.5）。
 *
 * 纯函数：把规范 token string 解析为编辑器节点描述，或把节点描述序列化回 token string。
 * 编辑器内部结构只是展示层；受控 value 始终是规范 token string（design D7）。
 */
import {
  extractWoohaa3CanvasMentions,
  serializeWoohaa3CanvasMention,
  type Woohaa3CanvasMention
} from "@woohaa3/contracts";

export type EditorNodeSpec =
  | { kind: "text"; text: string }
  | { kind: "mention"; mention: Woohaa3CanvasMention };

/** token string → 编辑器节点描述（普通文本 / mention 交替）。 */
export function tokenStringToEditorNodes(value: string): EditorNodeSpec[] {
  if (typeof value !== "string" || value === "") return [];
  return extractWoohaa3CanvasMentions(value).map((segment) =>
    segment.kind === "text"
      ? { kind: "text", text: segment.text }
      : { kind: "mention", mention: segment.mention }
  );
}

/**
 * 编辑器节点描述 → token string。
 *
 * `mentionToToken` 允许调用方在渲染前把「失效」mention 降级为普通文本展示；缺省用规范序列化。
 */
export function editorNodesToTokenString(
  nodes: readonly EditorNodeSpec[],
  serializeMention: (mention: Woohaa3CanvasMention) => string = defaultSerialize
): string {
  return nodes
    .map((node) =>
      node.kind === "text" ? node.text : serializeMention(node.mention)
    )
    .join("");
}

function defaultSerialize(mention: Woohaa3CanvasMention): string {
  return serializeWoohaa3CanvasMention(mention) ?? `@${mention.label}`;
}
