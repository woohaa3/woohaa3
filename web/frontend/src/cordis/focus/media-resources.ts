/**
 * 有界媒体资源的公共纯类型
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D8/D9，任务 4.1）。
 *
 * 只承载 CPU 位图 lease / 质量请求 / 来源 identity 的**纯类型**：runtime 服务契约据此暴露
 * 媒体资源获取能力，而不反向 import `plugins/canvas-runtime` 的具体实现。
 */

/** 稳定来源 identity：同一 canonical 素材的多 consumer 共享同一条目。 */
export type FocusMediaSource = {
  /** 素材稳定键（如 storageKey / 受控同源 URL 的规范键）。 */
  key: string;
  /** 期望质量命名空间（卡片/聚焦），仅用于质量请求；不参与共享键。 */
  quality?: "card" | "focus";
};

/** 一次成功媒体位图 lease 的释放句柄。 */
export type FocusMediaLease = {
  key: string;
  /** 释放本 consumer 的引用；引用归零后条目才可被预算回收。 */
  release: () => void;
};

/** 已解码的 CPU 位图表示（与 GPU handle 生命周期分离）。 */
export type FocusMediaBitmap = {
  bitmap: CanvasImageSource;
  width: number;
  height: number;
  /** 是否超过编辑资源上限（允许查看、禁止按原图保存）。 */
  tooLarge: boolean;
};
