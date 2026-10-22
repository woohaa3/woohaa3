import { lazy, Suspense } from "react";
import type { MentionEditorProps } from "./MentionEditor.js";

const Editor = lazy(() => import("./MentionEditor.js").then(module => ({ default: module.MentionEditor })));

/** Load Lexical's UI only when a prompt or snippet editor is opened. */
export function LazyMentionEditor(props: MentionEditorProps) {
  return <Suspense fallback={<div className="mention-editor__input" role="status">正在加载提示词编辑器…</div>}>
    <Editor {...props} />
  </Suspense>;
}
