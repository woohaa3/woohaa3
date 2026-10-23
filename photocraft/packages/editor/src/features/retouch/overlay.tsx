import { cloneOverlayPolygon, type ScreenPoint } from "./clone-overlay.js";

/**
 * 仿制源叠加取样框的渲染（change: 2026-10-22-add-photocraft-retouch-workflows，U39 / D2）。
 *
 * 共享画布只负责在合成预览之上放一层 SVG；取样框的四角、不透明度、可见性都由
 * `workspace.cloneOverlayFrame` + `clone-overlay.ts` 算好后传进来，这里**不再**解释
 * 缩放/旋转/翻转，也不读内核——保证「看到的取景」与「落笔的取样」是同一份映射。
 *
 * `frame.corners` 已是容器 CSS 像素（共享画布用 `origin + 文档坐标 · zoom` 换算过）。
 */
export type CloneOverlayFrame = {
  corners: ScreenPoint[];
  opacity: number;
  invert: boolean;
};

export function CloneSourceOverlay({ frame }: { frame: CloneOverlayFrame }) {
  const polygon = cloneOverlayPolygon(frame.corners, frame.opacity, frame.invert);
  if (!polygon) return null;
  return (
    <svg
      className="photo-editor-canvas__clone-overlay"
      data-testid="clone-source-overlay"
      data-invert={polygon.invert ? "true" : undefined}
      aria-hidden="true"
      // 叠加层只是提示：必须让指针事件穿过去，否则它盖住笔尖起始位置，
      // 画布的 pointerdown 收不到，落笔静默失败（真实走查发现的缺陷）。
      style={{ pointerEvents: "none" }}
    >
      <polygon
        points={polygon.points}
        fillOpacity={0.12 * polygon.opacity}
        strokeOpacity={polygon.opacity}
        style={polygon.invert ? { mixBlendMode: "difference" } : undefined}
      />
    </svg>
  );
}
