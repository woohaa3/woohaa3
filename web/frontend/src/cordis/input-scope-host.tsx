/**
 * Input Scope Host（change: adopt-frontend-cordis-plugin-runtime，design D3/D6）。
 *
 * 把 `input.paste` / `input.drop` slot contributions 聚合成 document-level handler，并在
 * modal/menu/editor 门禁激活时不处理画布 paste/drop。贡献随 Plugin dispose 撤销。
 */
import { useEffect } from "react";
import { useService } from "./react.js";
import { useSlot } from "./host.js";
import { isEditableElement } from "./plugins/canvas-shell/input/shortcuts.js";

/** 事件目标是否位于编辑面（input/textarea/contenteditable/菜单/弹窗）。 */
function isEditorTarget(target: EventTarget | null): boolean {
  return isEditableElement(target);
}

export function InputScopeHost() {
  const inputScopes = useService("inputScopes");
  const pasteContributions = useSlot("input.paste");
  const dropContributions = useSlot("input.drop");

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    // 编辑面（input/textarea/contenteditable/菜单/弹窗）保留原生 paste/drop；门禁是唯一来源。
    const onPaste = (event: ClipboardEvent) => {
      if (inputScopes.blocksCanvas() || isEditorTarget(event.target)) return;
      for (const entry of pasteContributions) {
        if (entry.handle(event) === true) {
          event.preventDefault();
          return;
        }
      }
    };
    const onDrop = (event: DragEvent) => {
      if (inputScopes.blocksCanvas() || isEditorTarget(event.target)) return;
      for (const entry of dropContributions) {
        if (entry.handle(event) === true) {
          event.preventDefault();
          return;
        }
      }
    };
    /**
     * dragover/dragenter 必须 `preventDefault` 浏览器才会派发 `drop`
     * （否则浏览器把文件当作导航目标，drop 永不触发）。`dragover` 阶段 DataTransfer
     * 不暴露文件内容，只能凭 `types` / `item.kind` / `item.type` 判定。
     */
    const onDragAccept = (event: DragEvent) => {
      if (inputScopes.blocksCanvas() || isEditorTarget(event.target)) return;
      // 只为**可接受**的 transfer 显示 drop 反馈；至少一个 contribution 接受时才阻止默认。
      const acceptable = dropContributions.some((entry) => entry.canAccept?.(event) ?? true);
      if (!acceptable) return;
      event.preventDefault();
      // 明确告知浏览器这是复制语义（文件不会被导航打开）。
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragover", onDragAccept);
    document.addEventListener("dragenter", onDragAccept);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", onDragAccept);
      document.removeEventListener("dragenter", onDragAccept);
    };
  }, [dropContributions, inputScopes, pasteContributions]);

  return null;
}
