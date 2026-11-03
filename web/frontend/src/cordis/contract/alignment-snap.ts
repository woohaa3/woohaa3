/**
 * 拖动吸附策略契约（纯类型）。
 *
 * 对齐**求解**属于 `alignment-guides` 扩展自己的业务，不放在 contracts：那是跨前后端/跨服务
 * 共享层，而这个能力只在浏览器内、只在这一个扩展与宿主拖动路径之间发生。宿主这里只声明
 * 两边交换的形状：矩形、参考线、策略返回值。
 */

/** 轴对齐矩形（世界坐标）。 */
export type AlignmentRect = { x: number; y: number; width: number; height: number };

/** 参考线：`axis:"x"` 是竖线（`position` 为世界 x），`axis:"y"` 是横线。 */
export type AlignmentGuide = {
  axis: "x" | "y";
  /** 线所在的世界坐标。 */
  position: number;
  /** 线段在另一轴上的起点。 */
  start: number;
  /** 线段在另一轴上的终点。 */
  end: number;
  /** 拖动框命中的那一侧：起点边 / 中心线 / 结束边（呈现层据此选样式）。 */
  kind: "start" | "center" | "end";
};

export type AlignmentSnapResult = {
  /** 叠加到拖动位移上的世界偏移。 */
  dx: number;
  dy: number;
  guides: readonly AlignmentGuide[];
};

/**
 * 插件侧对齐策略。
 *
 * 宿主只传世界坐标矩形与世界阈值（已按缩放换算）；策略自己决定是否启用、如何裁剪候选、
 * 最多输出几条参考线。返回 `null` 表示本次不吸附。
 */
export type AlignmentSnapPolicy = {
  resolve(input: {
    moving: readonly AlignmentRect[];
    candidates: readonly AlignmentRect[];
    threshold: number;
  }): AlignmentSnapResult | null;
};
