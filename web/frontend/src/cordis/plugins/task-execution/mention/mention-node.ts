/**
 * Lexical MentionNode 与 token codec 桥接
 * （change: add-reference-inputs-and-mentions，任务 4.1 / design D7）。
 *
 * MentionNode 只包装 contracts 的规范 token：serialize 成 `{{type:slotId:label}}`，
 * 展示为 `@label`。编辑器内部文档**不是**事实源 —— 受控 value 始终是 token string。
 */
import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from "lexical";
import type { Woohaa3CanvasMention } from "@woohaa3/contracts";
import { serializeWoohaa3CanvasMention } from "@woohaa3/contracts";

export type SerializedMentionNode = Spread<
  {
    mentionType: string;
    slotId: string;
    label: string;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<null> {
  __mention: Woohaa3CanvasMention;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mention, node.__key);
  }

  constructor(mention: Woohaa3CanvasMention, key?: NodeKey) {
    super(key);
    this.__mention = mention;
  }

  getMention(): Woohaa3CanvasMention {
    return this.__mention;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "mention-node";
    span.dataset.slotId = this.__mention.slotId;
    span.dataset.mentionType = this.__mention.type;
    span.textContent = `@${this.__mention.label}`;
    span.contentEditable = "false";
    return span;
  }

  updateDOM(prevNode: MentionNode, dom: HTMLElement): boolean {
    if (
      prevNode.__mention.slotId === this.__mention.slotId &&
      prevNode.__mention.label === this.__mention.label &&
      prevNode.__mention.type === this.__mention.type
    ) {
      return false;
    }
    dom.dataset.slotId = this.__mention.slotId;
    dom.dataset.mentionType = this.__mention.type;
    dom.textContent = `@${this.__mention.label}`;
    return true;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /** 受控值/选区偏移使用规范 token；剪贴板由 MentionClipboardPlugin 输出可读标签。 */
  getTextContent(): string {
    return serializeWoohaa3CanvasMention(this.__mention) ?? `@${this.__mention.label}`;
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: MentionNode.getType(),
      version: 1,
      mentionType: this.__mention.type,
      slotId: this.__mention.slotId,
      label: this.__mention.label
    };
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return $createMentionNode({
      type: serialized.mentionType as Woohaa3CanvasMention["type"],
      slotId: serialized.slotId,
      label: serialized.label
    });
  }
}

export function $createMentionNode(mention: Woohaa3CanvasMention): MentionNode {
  return $applyNodeReplacement(new MentionNode(mention));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}
