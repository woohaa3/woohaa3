import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isNodeSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, COPY_COMMAND, CUT_COMMAND } from "lexical";
import { tokenStringToEditorNodes } from "./codec-bridge.js";

/** Clipboard text uses readable labels; controlled values keep stable reference tokens. */
export function MentionClipboardPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false;
      if (cut && !editor.isEditable()) return false;
      const selection = $getSelection();
      if (!selection || selection.isCollapsed()) return false;
      const text = tokenStringToEditorNodes(selection.getTextContent()).map((spec) => {
        if (spec.kind === "text") return spec.text;
        // Numbered labels are displayed with optional spacing in the reference picker.
        return spec.mention.label.replace(/^(图片|视频)\s+(\d+)$/, "$1$2");
      }).join("");
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      if (cut) {
        if ($isRangeSelection(selection)) selection.removeText();
        else if ($isNodeSelection(selection)) selection.getNodes().forEach((node) => node.remove());
      }
      return true;
    };
    const removeCopy = editor.registerCommand(COPY_COMMAND, (event) => copy(event, false), COMMAND_PRIORITY_HIGH);
    const removeCut = editor.registerCommand(CUT_COMMAND, (event) => copy(event, true), COMMAND_PRIORITY_HIGH);
    return () => { removeCopy(); removeCut(); };
  }, [editor]);
  return null;
}
