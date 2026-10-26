/**
 * 模型镜头截图：Bevy 离屏渲染 → PNG 编码 → 原子提交
 * （change: 2026-09-28-split-frontend-god-plugins，task 4.5；从 model-editor-plugin 拆出）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { modelCameraAspectSize, type BevyModelEditor } from "@woohaa3/contracts";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import type { ModelShotCaptureSession } from "./model-shot-capture.js";
import { acquireCaptureLock, rgbaToPngBlob } from "../canvas-runtime/model-capture-shared.js";

export { acquireCaptureLock, rgbaToPngBlob } from "../canvas-runtime/model-capture-shared.js";

/**
 * 通过同一 Bevy renderer 的离屏目标渲染并回读，再用 canvas 编码 PNG
 * （change: add-model-editor-gizmo-shot-capture，任务 3.3/3.4；
 *   change: fix-model-focus-navigation-and-camera-parity，task 5.5：画幅决定输出像素尺寸）。
 */
/** 进程内单调的截图作用域代数：切镜头/关闭后旧结果按它丢弃。 */
let captureGeneration = 1;

export async function renderWithBevy(
  ctx: Context,
  input: { captureId: string; nodeId: string; shot: NonNullable<BevyModelEditor["shot"]> }
): Promise<{ ok: true; blob: Blob } | { ok: false; code: string; message: string }> {
  const runtime = ctx.canvasRuntime.runtime();
  if (!runtime) return { ok: false, code: "renderer-unavailable", message: "Bevy 运行时未就绪" };
  const size = modelCameraAspectSize(input.shot.aspect);
  // 串行化：capture 通道是 latest-wins（新请求取消进行中的作业），因此截图与预览
  // 必须一次只发一个，否则后到的请求会让前一个超时（存量缺陷）。
  const release = await acquireCaptureLock();
  try {
    const generation = captureGeneration++;
    const frame = await runtime.requestCapture({
      generation,
      nodeId: input.nodeId,
      width: size.width,
      height: size.height
    });
    if (!frame) return { ok: false, code: "capture-timeout", message: "截图渲染未完成" };
    const blob = await rgbaToPngBlob(frame.rgba, frame.width, frame.height);
    if (!blob) return { ok: false, code: "encode-failed", message: "PNG 编码失败" };
    return { ok: true, blob };
  } finally {
    release();
  }
}

/** 截图节点类型映射：模型/当前帧截图（change: 2026-10-12-unify-generation-history-strip，design D8）。 */

export async function captureSelected(
  ctx: Context,
  session: ModelEditorSession,
  captureSession: ModelShotCaptureSession,
  canvasId?: string
): Promise<void> {
  // 历史只读浏览禁止截图（change: 对齐 xyflow-bevy 历史只读浏览）。
  if (ctx.canvasRuntime.modelFocusMode() === "history") return;
  if (session.captureBusy || captureSession.busy) return;
  const state = session.getState();
  const nodeId = state.nodeId;
  const selected = session.selectedCamera();
  if (!nodeId || !selected) {
    session.setCapturePhase("failed", "当前无法截图");
    return;
  }
  // 本地生成操作：截图是 browser-local owner，经统一运行状态登记（不写 canonical、不经 Task）。
  const local = canvasId ? beginCanvasLocalOperation(ctx, canvasId, nodeId, "screenshot") : null;
  try {
    session.commitForCapture();
    session.setCapturePhase("rendering");
    // captureId 由 (nodeId, cameraId) 派生：同一镜头始终写回同一个截图节点。
    const result = await captureSession.capture({
      nodeId,
      cameraId: selected.id,
      cameraName: selected.name,
      captureId: `shot-${nodeId}-${selected.id}`
    });
    if (!result.ok) {
      local?.finish({ error: result.message });
      session.setCapturePhase("failed", result.message);
      return;
    }
    local?.finish();
    session.setCapturePhase("idle");
  } catch (error) {
    const message = error instanceof Error ? error.message : "截图失败";
    local?.finish({ error: message });
    session.setCapturePhase("failed", message);
  }
}

/** 通过注入的 runState 服务登记本地操作（缺失时返回 null，不阻断核心）。 */
function beginCanvasLocalOperation(
  ctx: Context,
  canvasId: string,
  nodeId: string,
  kind: "screenshot" | "frame-capture" | "video-export"
): { operationId: string; finish: (outcome?: { error?: string }) => void } | null {
  const service = ctx.get("runState") as import("../service-keys.js").RunStateService | undefined;
  if (!service) return null;
  return service.beginLocalOperation({ canvasId, nodeId, kind });
}
