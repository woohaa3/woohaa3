/**
 * 原生交换链要覆盖的 DOM 矩形（相对视口，CSS 像素）。
 *
 * `place_native_surface` 把窗口做成 origin+画布，相机视口再对齐画布洞。Metal NSView
 * 必须铺同一块区域；若只 layout 画布洞，视口 origin 会再偏移一次，左右把手的绘制
 * 和命中错开一条顶栏的距离（hover 闪一下、拖不出连线）。
 */
export function nativeDrawableLayout(host: {
  left: number;
  top: number;
  width: number;
  height: number;
}): [number, number, number, number] {
  const originX = host.width ? Math.round(host.left) : 0;
  const originY = host.height ? Math.round(host.top) : 0;
  const width = host.width || 1;
  const height = host.height || 1;
  return [0, 0, Math.max(1, originX + width), Math.max(1, originY + height)];
}
