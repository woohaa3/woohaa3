/**
 * 作品重命名输入浮层（change: 2026-10-09-improve-canvas-workflow，任务 2.3）。
 *
 * 受控 DOM 输入：Enter 确认、Escape 取消；只读时只查看不可提交。
 * 名称全文可读取；提交失败保留原值并显示原因。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { validateExplicitName } from "@woohaa3/contracts";
import type { NodeRenameStore } from "./rename-store.js";
import type { CanvasEditService } from "../../services/canvas-state/index.js";
import { submitNodeRename } from "./rename-node.js";
import { Button } from "@woohaa3/ui/primitives";

export type NodeRenameDialogProps = {
  store: NodeRenameStore;
  edit: CanvasEditService;
  writable: boolean;
};

export type NodeRenameOverlayProps = {
  store: NodeRenameStore;
  /** 从页面上下文解析当前 edit 服务与可写状态（每次渲染读取，避免过期）。 */
  resolve: () => { edit: CanvasEditService; writable: boolean };
};

/** 连接页面上下文的浮层包装：`plugin.ts`（非 JSX 文件）只在 render 中返回它。 */
export function NodeRenameOverlay({ store, resolve }: NodeRenameOverlayProps) {
  const { edit, writable } = resolve();
  return <NodeRenameDialog store={store} edit={edit} writable={writable} />;
}

export function NodeRenameDialog({ store, edit, writable }: NodeRenameDialogProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (state.nodeId) inputRef.current?.focus();
  }, [state.nodeId]);

  if (state.nodeId === null) return null;

  const commit = async () => {
    const validation = validateExplicitName(state.value);
    if (!validation.ok) {
      store.setError(validation.message);
      return;
    }
    store.setBusy(true);
    const result = await submitNodeRename({ edit, nodeId: state.nodeId!, name: validation.value });
    store.setBusy(false);
    if (!result.ok) {
      store.setError(result.error);
      return;
    }
    store.close();
  };

  return (
    <div className="node-rename" role="dialog" aria-modal="true" aria-label="重命名作品" data-testid="node-rename">
      <label className="node-rename__label" htmlFor="node-rename-input">作品名称</label>
      <input
        id="node-rename-input"
        ref={inputRef}
        className="node-rename__input"
        value={state.value}
        disabled={!writable || state.busy}
        maxLength={120}
        onChange={(event) => store.setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
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
      {state.error ? <p className="node-rename__error" role="alert">{state.error}</p> : null}
      <div className="node-rename__actions">
        <Button size="sm" tone="neutral" onClick={() => store.close()}>取消</Button>
        <Button size="sm" tone="primary" disabled={!writable || state.busy} onClick={() => void commit()}>
          确认
        </Button>
      </div>
    </div>
  );
}
