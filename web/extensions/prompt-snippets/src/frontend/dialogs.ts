/**
 * 片段 dialog definitions 与 payload validator
 * （change: add-prompt-snippet-library，任务 4.2 / design D8/D9）。
 *
 * 三个 dialog：library（库 + 标签双视图）、editor（新建/编辑）、delete-confirm。
 * 只声明可序列化 payload 与校验；renderer 由 plugin 提供，busy/Escape/焦点/输入隔离
 * 全部由 Dialog Service/Host 统一拥有，插件不新增 document listener。
 */
import { objectPayload } from "@woohaa3/frontend/extension-api";
import type { DialogDefinition } from "@woohaa3/frontend/extension-api";

export const SNIPPET_LIBRARY_DIALOG_ID = "prompt-snippet-library";
export const SNIPPET_EDITOR_DIALOG_ID = "prompt-snippet-editor";
export const SNIPPET_DELETE_DIALOG_ID = "prompt-snippet-delete-confirm";
export const SNIPPET_TAG_DELETE_DIALOG_ID = "prompt-snippet-tag-delete-confirm";

export type SnippetLibraryPayload = {
  /** 是否从执行面板打开（决定插入行为）。 */
  forInsert?: boolean;
  nodeId?: string;
};

export type SnippetEditorPayload = {
  mode: "create" | "edit";
  snippetId?: string;
  nodeId?: string;
  /** 打开编辑器的初始草稿（从执行面板捕获时携带）。 */
  draftName?: string;
  draftBody?: string;
  draftTagIds?: string[];
};

export type SnippetDeletePayload = {
  snippetId: string;
  name: string;
};

export const snippetLibraryDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<SnippetLibraryPayload>(SNIPPET_LIBRARY_DIALOG_ID, (value) => ({
    forInsert: value.forInsert === true,
    ...(typeof value.nodeId === "string" && value.nodeId !== "" ? { nodeId: value.nodeId } : {})
  }))
};

export const snippetEditorDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<SnippetEditorPayload>(SNIPPET_EDITOR_DIALOG_ID, (value) => {
    const mode = value.mode === "edit" ? "edit" : value.mode === "create" ? "create" : null;
    if (!mode) return null;
    return {
      mode,
      ...(typeof value.snippetId === "string" && value.snippetId !== "" ? { snippetId: value.snippetId } : {}),
      ...(typeof value.nodeId === "string" && value.nodeId !== "" ? { nodeId: value.nodeId } : {}),
      ...(typeof value.draftName === "string" ? { draftName: value.draftName } : {}),
      ...(typeof value.draftBody === "string" ? { draftBody: value.draftBody } : {}),
      ...(Array.isArray(value.draftTagIds)
        ? { draftTagIds: value.draftTagIds.filter((entry): entry is string => typeof entry === "string") }
        : {})
    };
  })
};

export type TagDeletePayload = { tagId: string; name: string };

export const snippetDeleteDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  size: "sm",
  variant: "alert",
  validatePayload: objectPayload<SnippetDeletePayload>(SNIPPET_DELETE_DIALOG_ID, (value) => {
    const snippetId = value.snippetId;
    const name = value.name;
    if (typeof snippetId !== "string" || snippetId === "") return null;
    if (typeof name !== "string" || name === "") return null;
    return { snippetId, name };
  })
};

export const snippetTagDeleteDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  size: "sm",
  variant: "alert",
  validatePayload: objectPayload<TagDeletePayload>(SNIPPET_TAG_DELETE_DIALOG_ID, (value) => {
    const tagId = value.tagId;
    const name = value.name;
    if (typeof tagId !== "string" || tagId === "") return null;
    if (typeof name !== "string" || name === "") return null;
    return { tagId, name };
  })
};
