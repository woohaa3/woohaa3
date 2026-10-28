/**
 * 参考 tile 的媒体悬浮预览
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 2.4 / design D2；
 *  change: adopt-radix-remaining-canvas-ui：portal/滚动跟随/碰撞由受控 Popover 承担）。
 *
 * 迁移前是手工 `resize/scroll` 监听 + `getBoundingClientRect` 定位 + `createPortal`。现在由
 * 受控 Popover（anchor 模式）承载 portal 与碰撞，本组件只保留确定尺寸（宽度/高度上限）与
 * 媒体呈现。`pointer-events: none`、不接收指针；只展示宿主传入的稳定同源 URL。
 *
 * 生命周期：由 tile 在 hover/focus 时挂载，在 pointer leave / blur / unmount / panel
 * presentation 变化时卸载（父级据此条件渲染）。
 */
import { useMemo } from "react";
import { Popover } from "@woohaa3/ui";

const MAX_WIDTH = 320;
const MAX_HEIGHT = 240;
const GAP = 8;
const MIN_WIDTH = 160;
const VIEWPORT_MARGIN = 12;

export type ReferenceMediaPreviewProps = {
  kind: "image" | "video";
  url: string;
  alt: string;
  /** 锚点 tile 元素；null 时不渲染。 */
  anchor: HTMLElement | null;
};

export function ReferenceMediaPreview({ kind, url, alt, anchor }: ReferenceMediaPreviewProps) {
  // 只保留确定尺寸边界（不含定位）；定位/碰撞/flip 由 Popover 负责。
  const size = useMemo(() => {
    if (typeof window === "undefined") return { width: MAX_WIDTH, height: MAX_HEIGHT };
    const width = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
    );
    return { width, height: MAX_HEIGHT };
  }, []);

  if (!anchor || typeof document === "undefined") return null;

  return (
    <Popover
      open
      onOpenChange={() => undefined}
      anchorElement={anchor}
      side="top"
      align="center"
      sideOffset={GAP}
      className="ref-preview"
      dismissOnOutside={false}
      dismissOnEscape={false}
      restoreFocus={false}
      autoFocus={false}
    >
      <div
        role="presentation"
        aria-hidden="true"
        style={{ width: size.width - 14, maxHeight: size.height, pointerEvents: "none" }}
      >
        {kind === "video" ? (
          <video
            className="ref-preview__media"
            style={{ maxHeight: size.height - 12 }}
            src={url}
            muted
            playsInline
            preload="metadata"
            controls={false}
            autoPlay={false}
          />
        ) : (
          <img
            className="ref-preview__media"
            style={{ maxHeight: size.height - 12 }}
            src={url}
            alt={alt}
          />
        )}
      </div>
    </Popover>
  );
}
