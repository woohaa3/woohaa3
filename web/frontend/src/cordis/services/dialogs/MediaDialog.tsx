/**
 * MediaDialog 内容（change: add-frontend-dialog-system，任务 4.3 / design D8；
 *  change: 2026-09-29-align-node-media-dialogs，迁移到共享媒体工作区）。
 *
 * 共享 media fullscreen Dialog：保留原 `MediaLightbox` 的 0.25–5 倍缩放、滚轮缩放、
 * 左键拖动平移、重置、标题与关闭。查看状态（zoom/offset）是会话内瞬时 UI，
 * 不写任何规范状态。切换 asset identity 时由父级以 `key`/identity 重挂载重置。
 *
 * 应用 chrome（Header/Toolbar/Close）只消费 `--app-web-*`/`--app-interaction-*`；
 * 深色媒体 token 只作用于中性舞台与叠层画面，外围不再成为第二套暗色主题。
 *
 * 本组件**不自行监听全局 Escape**：关闭统一由 Dialog Host 处理（design D9）。
 */
import { AudioPlayer } from "../../../shared/ui/AudioPlayer.js";
import { useRef, useState } from "react";
import {
  Dialog,
  DialogIconButton,
  DialogMediaWorkspace,
  DialogStage,
  DialogTitle
} from "./Dialog.js";
import { FitScreenIcon, ZoomInIcon, ZoomOutIcon } from "../../../shared/ui/icons.js";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

export type MediaDialogProps = {
  instanceId: string;
  title: string;
  /** 稳定的合规媒体 URL；失效时为 null，显示不可用状态。 */
  url: string | null;
  kind?: "image" | "video" | "audio";
  /** 资产失效时的诊断信息。 */
  unavailableReason?: string;
  onClose: () => void;
};

const clamp = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

export function MediaDialog(props: MediaDialogProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; start: { x: number; y: number }; origin: { x: number; y: number } } | null>(
    null
  );

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const unavailable = !props.url;
  const title = props.title || "媒体预览";

  return (
    <Dialog.Content
      variant="media"
      size="fullscreen"
      ariaLabel={title}
      instanceId={props.instanceId}
      onOverlayClick={props.onClose}
    >
      <Dialog.Header onClose={props.onClose}>
        <DialogTitle>{title}</DialogTitle>
      </Dialog.Header>
      {unavailable ? (
        <Dialog.Body className="dlg__body--media">
          <p className="dlg__error" role="alert">
            {props.unavailableReason ?? "媒体不可用"}
          </p>
        </Dialog.Body>
      ) : props.kind === "audio" ? (
        <Dialog.Body><AudioPlayer url={props.url!} /></Dialog.Body>
      ) : (
        <DialogMediaWorkspace>
          <Dialog.Toolbar className="dlg__media-toolbar" label="媒体查看控制">
            <DialogIconButton
              label="缩小"
              tooltip="缩小"
              icon={<ZoomOutIcon className="dlg__icon" />}
              onClick={() => setZoom((value) => clamp(value * 0.88))}
            />
            <span className="dlg__zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <DialogIconButton
              label="放大"
              tooltip="放大"
              icon={<ZoomInIcon className="dlg__icon" />}
              onClick={() => setZoom((value) => clamp(value * 1.12))}
            />
            <DialogIconButton
              label="适应屏幕并重置"
              tooltip="适应屏幕并重置"
              icon={<FitScreenIcon className="dlg__icon" />}
              onClick={reset}
            />
          </Dialog.Toolbar>
          <DialogStage className="dlg__stage--image" label="图片预览">
            <div
              className="dlg__media-viewport"
              onWheel={(event) => {
                event.preventDefault();
                setZoom((value) => clamp(value * (event.deltaY < 0 ? 1.12 : 0.88)));
              }}
              onPointerDown={(event) => {
                dragRef.current = {
                  pointerId: event.pointerId,
                  start: { x: event.clientX, y: event.clientY },
                  origin: offset
                };
                (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                setOffset({
                  x: drag.origin.x + (event.clientX - drag.start.x),
                  y: drag.origin.y + (event.clientY - drag.start.y)
                });
              }}
              onPointerUp={(event) => {
                dragRef.current = null;
                (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
              }}
              onPointerCancel={(event) => {
                dragRef.current = null;
                (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
              }}
            >
              {props.kind === "video" ? (
                <video
                  className="dlg__media"
                  style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
                  src={props.url ?? undefined}
                  controls
                  autoPlay
                />
              ) : (
                <img
                  className="dlg__media"
                  style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
                  src={props.url ?? undefined}
                  alt={title}
                  draggable={false}
                />
              )}
            </div>
          </DialogStage>
        </DialogMediaWorkspace>
      )}
    </Dialog.Content>
  );
}
