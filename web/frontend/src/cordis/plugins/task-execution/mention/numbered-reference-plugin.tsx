import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $addUpdateTag, $createLineBreakNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, BLUR_COMMAND, COMMAND_PRIORITY_HIGH, SKIP_DOM_SELECTION_TAG, PASTE_COMMAND, TextNode, type LexicalNode } from "lexical";
import type { MentionCandidate } from "./mention-types.js";
import { tokenStringToEditorNodes, editorNodesToTokenString, type EditorNodeSpec } from "./codec-bridge.js";
import { $createMentionNode } from "./mention-node.js";

/** Resolve numbered aliases against canonical labels, never against arbitrary array order. */
export function numberedReferenceMatches(text: string, candidates: readonly MentionCandidate[]) {
  const aliases = new Map<string, MentionCandidate | null>();
  for (const candidate of candidates) {
    if (candidate.disabled) continue;
    const label = /^(图片|视频)\s*([1-9]\d*)$/.exec(candidate.label);
    if (!label || candidate.type !== (label[1] === "图片" ? "input_image" : "input_video")) continue;
    const key = `${label[1]}${label[2]}`;
    aliases.set(key, aliases.has(key) ? null : candidate);
  }
  return [...text.matchAll(/(?<![A-Za-z0-9_@])@?(图片|视频)\s*([1-9]\d*)(?!\d)/g)].flatMap((match) => {
    const candidate = aliases.get(`${match[1]}${match[2]}`);
    return candidate ? [{ start: match.index!, end: match.index! + match[0].length, candidate }] : [];
  });
}

/** Preserve existing stable tokens; normalize only ordinary text. */
export function normalizeNumberedReferences(value: string, candidates: readonly MentionCandidate[]): string {
  const specs = tokenStringToEditorNodes(value).flatMap<EditorNodeSpec>((spec) => {
    if (spec.kind === "mention") return [spec];
    const result: ReturnType<typeof tokenStringToEditorNodes> = [];
    let offset = 0;
    for (const match of numberedReferenceMatches(spec.text, candidates)) {
      if (match.start > offset) result.push({ kind: "text", text: spec.text.slice(offset, match.start) });
      result.push({ kind: "mention", mention: { type: match.candidate.type, slotId: match.candidate.slotId, label: match.candidate.label } });
      offset = match.end;
    }
    if (offset < spec.text.length) result.push({ kind: "text", text: spec.text.slice(offset) });
    return result;
  });
  return editorNodesToTokenString(specs);
}

export function NumberedReferencePlugin({ candidates }: { candidates: readonly MentionCandidate[] }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let commitEnding = false;
    const removeTransform = editor.registerNodeTransform(TextNode, (node) => {
      // Updating reference candidates re-runs transforms, including when a parameter control owns focus.
      // Normalization must not reclaim that focus via Lexical's DOM selection reconciliation.
      const root = editor.getRootElement();
      if (root && !root.contains(root.ownerDocument.activeElement)) $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      if (!node.isSimpleText() || editor.isComposing()) return;
      const selection = $getSelection();
      const match = numberedReferenceMatches(node.getTextContent(), candidates).find((entry) => {
        // Keep the number editable at the caret: typing 图片10 must not bind 图片1 halfway through.
        return commitEnding || !($isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.key === node.getKey() && selection.anchor.offset === entry.end);
      });
      if (!match) return;
      const pieces = node.splitText(match.start, match.end);
      const matched = pieces[match.start === 0 ? 0 : 1];
      matched?.replace($createMentionNode({ type: match.candidate.type, slotId: match.candidate.slotId, label: match.candidate.label }));
    });
    const removePaste = editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!event || !("clipboardData" in event) || !editor.isEditable() || editor.isComposing()) return false;
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return false;
      const normalized = normalizeNumberedReferences(text, candidates);
      if (normalized === text) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      event.preventDefault();
      const nodes = tokenStringToEditorNodes(normalized).flatMap<LexicalNode>((spec) => {
        if (spec.kind === "mention") return [$createMentionNode(spec.mention)];
        return spec.text.split("\n").flatMap((line, index) => [...(index ? [$createLineBreakNode()] : []), ...(line ? [$createTextNode(line)] : [])]);
      });
      selection.insertNodes(nodes);
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const removeBlur = editor.registerCommand(BLUR_COMMAND, () => {
      if (editor.isComposing()) return false;
      $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      editor.update(() => {
        commitEnding = true;
        for (const node of $getRoot().getAllTextNodes()) {
          if (numberedReferenceMatches(node.getTextContent(), candidates).length) node.markDirty();
        }
        // Blur normalization changes tokens, but must not refocus the prompt after a popup opens.
      }, { tag: SKIP_DOM_SELECTION_TAG, discrete: true, onUpdate: () => { commitEnding = false; } });
      return false;
    }, COMMAND_PRIORITY_HIGH);
    return () => { removeTransform(); removePaste(); removeBlur(); };
  }, [editor, candidates]);
  return null;
}
