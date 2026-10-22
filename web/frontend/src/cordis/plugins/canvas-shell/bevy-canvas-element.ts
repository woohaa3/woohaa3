/**
 * 页面级输入 canvas 单例，跨页面 scope 复用。
 *
 * 此元素由父页面持有输入和尺寸；真正的 Bevy canvas 位于 runtime-realm 的独立 iframe。
 * 宿主切换不替换输入元素；页面 scope 负责销毁旧 renderer 并在新宿主中创建独立上下文。
 * 移除此输入元素不等于销毁页面级 Runtime facade。
 */

const CANVAS_ID = "bevy-canvas";

let canvas: HTMLCanvasElement | null = null;

/** 把单例 canvas 挂进宿主容器（首次调用时创建）。返回同一元素。 */
export function mountBevyCanvas(host: HTMLElement): HTMLCanvasElement {
  canvas ??= createCanvasElement();
  if (canvas.parentElement !== host) host.appendChild(canvas);
  return canvas;
}

/**
 * 从宿主移除输入 canvas，但保留元素，下一次挂载复用同一元素。
 * 仅当元素仍属于该宿主时才移除，避免旧 scope 的迟到 cleanup 抢走新 scope 已挂载的画布。
 */
export function unmountBevyCanvas(host: HTMLElement): void {
  if (canvas && canvas.parentElement === host) canvas.remove();
}

/** 当前单例 canvas 元素（尚未创建时返回 null）。 */
export function currentBevyCanvas(): HTMLCanvasElement | null {
  return canvas;
}

/** 仅测试：彻底重置单例。 */
export function resetBevyCanvasElement(): void {
  canvas?.remove();
  canvas = null;
}

function createCanvasElement(): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.id = CANVAS_ID;
  return element;
}
