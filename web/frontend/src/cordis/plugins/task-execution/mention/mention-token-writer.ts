import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { $createMentionNode } from "./mention-node.js";
import { tokenStringToEditorNodes } from "./codec-bridge.js";

export function setEditorFromTokenString(editor: LexicalEditor, value: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    let paragraph = $createParagraphNode();
    root.append(paragraph);
    for (const spec of tokenStringToEditorNodes(value)) {
      if (spec.kind === "mention") {
        paragraph.append($createMentionNode(spec.mention));
        continue;
      }
      const parts = spec.text.split("\n");
      parts.forEach((line, index) => {
        if (index > 0) {
          paragraph = $createParagraphNode();
          root.append(paragraph);
        }
        if (line !== "") paragraph.append($createTextNode(line));
      });
    }
  });
}

