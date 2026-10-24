/**
 * 独立文件文档的呈现层
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 2.4/3.3 / design D4/D5）。
 *
 * 文件文档与节点文档共用同一个编辑器界面：编辑器画布仍是透明交互层，文件文档经
 * `renderCanvasBackground` 端口绘制**自己的** RGBA 预览。容器提供不透明主题背景与
 * 棋盘格，因此底层画布不会透出，也不存在第二个主动图。
 *
 * 底部动作条承载独立文件特有的保存目的地：保存工程、导出 PNG、添加到画布。全部经宿主
 * 端口执行；这里只呈现结果（可信写入 / 仅发起下载 / 取消 / 失败）。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/photocraft-editor/ui";
import type { EditorPreview } from "@woohaa3/photocraft-editor";
import type { FileDocumentWorkspace } from "./file-document-workspace.js";

/** 用 Canvas 画出同一修订的 RGBA 预览（透明像素由底下的棋盘格承接）。 */
export function DocumentPreviewCanvas({ preview, width, height, zoom, origin }: {
  preview: EditorPreview;
  width: number;
  height: number;
  zoom: number;
  origin: { x: number; y: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0);
  }, [preview]);
  return (
    <canvas
      ref={canvasRef}
      className="photo-document-surface__preview"
      data-document-preview="true"
      style={{ position: "absolute", left: origin.x, top: origin.y, width: width * zoom, height: height * zoom }}
    />
  );
}

export type FileDocumentActions = {
  /** 保存工程到本地文件（`.pcraft`）。 */
  saveProject: () => void;
  /** 另存为：先让用户给出目标文件名，再走同一交付端口（I042）。 */
  saveProjectAs?: (fileName: string) => void;
  /** 导出合成 PNG（不代表工程已保存）。 */
  exportPng: () => void;
  /** 显式添加到当前画布（发布工程 + PNG 与图片节点）。 */
  addToCanvas?: () => void;
  /** 「添加到画布」被拒绝的原因（只读画布/断线）；null 表示可用。 */
  addToCanvasBlocked?: string | null;
};

export type FileDocumentActionsBarProps = {
  view: FileDocumentWorkspace;
  actions: FileDocumentActions;
  /** 当前未保存/交付状态文案。 */
  status: string | null;
  statusTone?: "error" | "info";
  busy?: boolean;
  readonly?: boolean;
};

/** 独立文件文档的底部动作条（不承载编辑工具；工具仍由编辑器拥有）。 */
export function FileDocumentActionsBar({ view, actions, status, statusTone = "info", busy = false, readonly = false }: FileDocumentActionsBarProps) {
  useSyncExternalStore(
    useCallback((listener) => view.subscribe(listener), [view]),
    useCallback(() => view.revisionState(), [view])
  );
  return (
    <div className="photo-document-surface__actions" data-document-actions="true">
      <span className="photo-document-surface__status" data-tone={statusTone} role="status">
        {status ?? "独立文件文档 · 不写入画布"}
      </span>
      <Button size="sm" tone="ghost" disabled={busy || readonly} onClick={actions.saveProject} title="保存工程到本地文件">保存工程…</Button>
      {actions.saveProjectAs?<Button size="sm" tone="ghost" disabled={busy || readonly}
        title="以新文件名保存工程副本（不改变当前文档名）"
        onClick={()=>{
          const suggested=`${view.fileName.replace(/\.[^.]+$/,"")||"photocraft"}-副本.pcraft`;
          const name=globalThis.prompt?.("另存为（文件名）",suggested);
          const normalized=(name??"").trim();
          if(!normalized)return;
          actions.saveProjectAs?.(normalized.toLowerCase().endsWith(".pcraft")?normalized:`${normalized}.pcraft`);
        }}>另存为…</Button>:null}
      <Button size="sm" tone="ghost" disabled={busy} onClick={actions.exportPng} title="导出当前合成 PNG（不改变工程保存状态）">导出 PNG</Button>
      {actions.addToCanvas ? (
        <Button
          size="sm"
          tone="primary"
          disabled={busy || readonly || !!actions.addToCanvasBlocked}
          title={actions.addToCanvasBlocked ?? "在当前画布创建带工程的图片节点"}
          onClick={actions.addToCanvas}
        >添加到画布</Button>
      ) : null}
    </div>
  );
}
