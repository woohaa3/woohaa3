/**
 * 便签正文编辑浮层。
 *
 * 便签的正文是长文本，浮层贴在便签**原来的位置**附近（而不是屏幕正中），
 * 用户改的时候能看见自己写的那张纸，不会失去上下文。
 * 位置由调用方按便签的屏幕矩形传入；拿不到矩形时退回屏幕居中。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { planNodeDataPatch } from "../../../extension-api/command-planner.js";
import type { CanvasEditService } from "../../services/canvas-state/index.js";
import { STICKY_NOTE_MAX_LENGTH, type StickyNoteStore } from "./sticky-note-store.js";
import { Button } from "@woohaa3/ui/primitives";

export type StickyNoteAnchor = { left: number; top: number; width: number };

export type StickyNoteDialogProps = {
  store: StickyNoteStore;
  edit: CanvasEditService;
  writable: boolean;
  /** 便签在页面上的屏幕位置；缺省时浮层居中。 */
  anchor: StickyNoteAnchor | null;
};

export type StickyNoteOverlayProps = Omit<StickyNoteDialogProps, "store" | "anchor"> & {
  store: StickyNoteStore;
  resolveAnchor: (nodeId: string) => StickyNoteAnchor | null;
};

/** 连接页面上下文的浮层包装：只在 render 中取 anchor，避免 store 里存几何。 */
export function StickyNoteOverlay({ store, edit, writable, resolveAnchor }: StickyNoteOverlayProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <StickyNoteDialog
      store={store}
      edit={edit}
      writable={writable}
      anchor={state.nodeId ? resolveAnchor(state.nodeId) : null}
    />
  );
}

export function StickyNoteDialog({ store, edit, writable, anchor }: StickyNoteDialogProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (state.nodeId) {
      const input = inputRef.current;
      input?.focus();
      // 光标落到末尾：用户打开是为了继续写，不是为了从头读。
      const end = input?.value.length ?? 0;
      input?.setSelectionRange(end, end);
    }
  }, [state.nodeId]);

  if (state.nodeId === null) return null;

  const commit = async () => {
    const nodeId = state.nodeId;
    if (!nodeId) return;
    store.setBusy(true);
    const result = await edit.record(
      planNodeDataPatch({ nodeId, value: { note: state.value.slice(0, STICKY_NOTE_MAX_LENGTH) } }),
      "编辑便签"
    );
    store.setBusy(false);
    if (!result.ok) {
      store.setError(result.reason ?? "保存失败，请重试");
      return;
    }
    store.close();
  };

  // 浮层落在便签下方；贴着视口底边时改到便签上方，避免被裁掉。
  const style = anchor
    ? {
        left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - 372))}px`,
        top: `${Math.min(anchor.top + 8, window.innerHeight - 260)}px`
      }
    : undefined;

  return (
    <div
      className="sticky-note-editor"
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label="编辑便签"
      data-testid="sticky-note-editor"
    >
      <label className="sticky-note-editor__label" htmlFor="sticky-note-input">
        便签内容
      </label>
      <textarea
        id="sticky-note-input"
        ref={inputRef}
        className="sticky-note-editor__input"
        value={state.value}
        disabled={!writable || state.busy}
        maxLength={STICKY_NOTE_MAX_LENGTH}
        rows={6}
        placeholder="写点什么…"
        onChange={(event) => store.setValue(event.target.value)}
        onKeyDown={(event) => {
          // 普通 Enter 换行（笔记本来就该能换行）；Ctrl/Cmd+Enter 提交。
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            store.close();
          }
        }}
      />
      {state.error ? <p className="sticky-note-editor__error" role="alert">{state.error}</p> : null}
      <div className="sticky-note-editor__actions">
        <span className="sticky-note-editor__hint">Ctrl + Enter 保存</span>
        <Button size="sm" tone="neutral" onClick={() => store.close()}>取消</Button>
        <Button size="sm" tone="primary" disabled={!writable || state.busy} onClick={() => void commit()}>
          保存
        </Button>
      </div>
    </div>
  );
}
