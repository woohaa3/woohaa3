/**
 * 公共聚焦平台层的纯类型
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1/D4）。
 *
 * 本模块只承载跨三类 editor、Canvas Shell 与 Canvas Runtime 共用的**纯类型**：
 * MUST NOT 依赖 React、具体 Plugin、Canvas manifest 或 shell controller。runtime 服务契约据此
 * 依赖公共纯类型，而不反向 import shell 的 React 实现。
 */

/** 聚焦可用内容矩形（CSS 像素）。所有控件都落在 contentRect 之外。 */
export type FocusContentRect = { x: number; y: number; width: number; height: number };

/** 内容区相对画布表面的内距（CSS 像素）。 */
export type FocusInsets = { left: number; right: number; top: number; bottom: number };

/** 二维画布表面矩形（CSS 像素）。 */
export type FocusSurfaceRect = { x: number; y: number; width: number; height: number };

/** 画布输入当前操作的二维聚焦取景；不持有手势或 DOM 监听。 */
export type FocusViewportTarget = {
  read: () => { viewport: { x: number; y: number; zoom: number }; rect: FocusContentRect } | null;
  write: (viewport: { x: number; y: number; zoom: number }) => void;
};
