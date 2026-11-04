/**
 * 辅助对齐线覆盖层。
 *
 * 只做呈现：从 Canvas Runtime 读取**当前拖动**命中的世界坐标线段，用唯一本地视口换算成
 * client 坐标后画成 DOM 虚线。拖动预览与吸附求解都在宿主拖动路径里，本组件不参与命中、
 * 不写画布、不产生命令。
 *
 * 样式约定：
 * - 全部是虚线：边线（左/右、上/下）实一点，中心线更淡，避免"中心线抢戏"；
 * - 线宽固定 1px，不随画布缩放变化——它是一把标尺，不是场景内容；
 * - 用 DOM 而不是 scene：参考线跟着指针走即可，DOM 能保持恒定线宽，也不必扩渲染协议。
 */
import { useSyncExternalStore } from "react";
import type { CanvasRuntimeService } from "@woohaa3/frontend/extension-api";
import "./style.css";

/** 对齐线颜色：跟随主题交互色；未定义时退回同一份兜底色。 */
const GUIDE_COLOR = "var(--app-interaction-accent, #6b7cff)";
/** 边线：虚线段与间隔（CSS px）。 */
const EDGE_DASH = 4;
const EDGE_GAP = 4;
/** 中心线：更短的虚线段 + 更大的间隔，配合更低不透明度。 */
const CENTER_DASH = 2;
const CENTER_GAP = 4;

export function AlignmentGuidesOverlay({ runtime }: { runtime: CanvasRuntimeService }) {
  // 版本号只在参考线内容变化时递增：拖动过程中指针每动一次都会重新求一次吸附，
  // 没有这条门禁会让覆盖层跟着每帧重渲染。
  const version = useSyncExternalStore(
    listener => runtime.subscribeFrame?.(listener) ?? (() => {}),
    () => runtime.alignmentGuidesVersion?.() ?? 0,
    () => 0
  );
  void version;
  const guides = runtime.alignmentGuides?.() ?? [];
  if (guides.length === 0) return null;
  return (
    <div className="alignment-guides" aria-hidden="true">
      {guides.map((guide, index) => {
        const vertical = guide.axis === "x";
        const source = runtime.worldToClient({ x: vertical ? guide.position : guide.start, y: vertical ? guide.start : guide.position });
        const target = runtime.worldToClient({ x: vertical ? guide.position : guide.end, y: vertical ? guide.end : guide.position });
        if (!source || !target) return null;
        const centerLine = guide.kind === "center";
        const dash = centerLine ? CENTER_DASH : EDGE_DASH;
        const gap = centerLine ? CENTER_GAP : EDGE_GAP;
        const style = {
          ...(vertical
            ? {
                left: `${Math.round(source.x)}px`,
                top: `${Math.round(Math.min(source.y, target.y))}px`,
                width: "1px",
                height: `${Math.max(1, Math.round(Math.abs(target.y - source.y)))}px`
              }
            : {
                left: `${Math.round(Math.min(source.x, target.x))}px`,
                top: `${Math.round(source.y)}px`,
                width: `${Math.max(1, Math.round(Math.abs(target.x - source.x)))}px`,
                height: "1px"
              }),
          backgroundImage: `repeating-linear-gradient(${vertical ? "to bottom" : "to right"}, ${GUIDE_COLOR} 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`,
          // 中心线更淡：它是"参考"，不是"边界"。
          opacity: centerLine ? 0.45 : 0.9
        };
        return (
          <div
            key={`${guide.axis}:${guide.position}:${index}`}
            className={`alignment-guides__line alignment-guides__line--${centerLine ? "center" : "edge"}`}
            style={style}
          />
        );
      })}
    </div>
  );
}
