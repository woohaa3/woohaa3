/**
 * 模型聚焦取景控件（model-editor 专用）
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3）。
 *
 * 从旧 shell `model-focus-back.tsx` 的模型专用视图控件迁入 model-editor：缩放与适应窗口由
 * Canvas Runtime controller 的所有权方法驱动（经 canvasRuntime service 访问，不 import shell）。
 * 公共 header 只经 props 接收该节点操作，不按 kind 选镜头工具。
 */
import { useService } from "../../react.js";
import { Button } from "@woohaa3/ui/primitives";

export function ModelViewControls({ nodeId }: { nodeId: string }) {
  const runtime = useService("canvasRuntime");
  return (
    <div className="focus-workspace__view-controls" data-focus-canvas-chrome="true">
      <Button size="sm" aria-label="缩小" onClick={() => runtime.controller()?.zoomFocusedModel(1 / 1.2)}>−</Button>
      <Button size="sm" onClick={() => runtime.controller()?.reframeModelFocus(nodeId)}>适应窗口</Button>
      <Button size="sm" aria-label="放大" onClick={() => runtime.controller()?.zoomFocusedModel(1.2)}>+</Button>
    </div>
  );
}
