import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useFocusWorkspace } from "../../focus/workspace.js";
import { modelCameraAspectRatio } from "@woohaa3/contracts";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";

/** Bevy 的窗口 viewport 外框；内部保持透明，显示同一 canvas 上的实时取景。 */
export function ModelCameraPreview({ session, readOnly = false }: { session: ModelEditorSession; readOnly?: boolean }) {
  const workspace = useFocusWorkspace();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const camera = session.selectedCamera();
  const pose = camera ? session.effectivePose(camera) : null;
  const aspect = pose ? modelCameraAspectRatio(pose.aspect) : 16 / 9;
  const active = Boolean(!readOnly && state.nodeId && state.toolMode === "camera" && camera);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    const canvas = document.getElementById("bevy-canvas");
    const toolbar = document.querySelector(".model-editor");
    if (!canvas || !toolbar) return;
    const update = () => {
      const bounds = canvas.getBoundingClientRect();
      const content = workspace?.contentRect ?? { x: 0, y: 0, width: bounds.width - toolbar.getBoundingClientRect().width, height: bounds.height };
      const contentWidth = Math.max(1, content.width);
      // 与 bevy/src/app/scene3d.rs 的 rig_preview_rect 保持一致。
      const maxWidth = Math.min(340, Math.max(workspace ? 1 : 180, (contentWidth - 32) * 0.32));
      const maxHeight = Math.min(220, Math.max(workspace ? 1 : 120, (content.height - (workspace ? 56 : 32)) * 0.30));
      const height = Math.min(maxWidth / aspect, maxHeight);
      setRect({ left: bounds.left + content.x + 16, top: bounds.top + content.y + Math.max(0, content.height - height - (workspace ? 64 : 16)), width: height * aspect, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    observer.observe(toolbar);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [active, aspect, workspace?.contentRect.x, workspace?.contentRect.y, workspace?.contentRect.width, workspace?.contentRect.height]);

  if (!active || !rect) return null;
  return (
    <section className="model-camera-preview" style={rect} aria-label="镜头实时预览">
      <div className="model-camera-preview__header">
        <span>预览 · {camera!.name}</span>
        <span>{pose!.aspect}</span>
      </div>
    </section>
  );
}
