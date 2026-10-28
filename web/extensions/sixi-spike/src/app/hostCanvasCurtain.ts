/**
 * 宿主画布遮罩 —— 必须在**模块求值阶段**就生效，不能等 React 或外部样式表。
 *
 * 实测的启动顺序是：宿主画布先画出来 → 扩展 chunk 求值 → 扩展的 CSS `<link>` 才下载完成。
 * 因此只靠扩展样式表里的 `html[data-sixi-shell] .app { visibility: hidden }` 会有两处露馅：
 *   1. chunk 求值前后的空档；
 *   2. chunk 求值后、样式表到达前的空档（`<link>` 是异步的）。
 * 这里在模块求值时同步注入一段内联 `<style>`，把等待网络的那段时间抹掉；
 * 扩展样式表里的同名规则作为兜底保留（两份内容一致）。
 */

const CURTAIN_STYLE_ID = "sixi-host-curtain";
const SHELL_ATTR = "sixiShell";

/**
 * 内联样式：隐藏宿主 `.app`（画布与宿主控件的共同祖先），再把四喜自己的容器打回可见。
 * 用 `visibility` 而不是 `display`/`opacity`：不卸载、不改布局，画布在下面继续存活。
 */
const CURTAIN_CSS = `
html[data-sixi-shell="1"] .app { visibility: hidden; }
html[data-sixi-shell="1"] .sixi-host-root,
html[data-sixi-shell="1"] .sixi-host-back { visibility: visible; }
`.trim();

function ensureCurtainStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(CURTAIN_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CURTAIN_STYLE_ID;
  style.dataset.sixiExtension = "sixi-spike";
  style.textContent = CURTAIN_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * 打开 / 关闭遮罩。关闭时只摘属性，保留 `<style>`：
 * 再次进入四喜时不必等网络，也就不会重演一次闪烁。
 */
export function setHostCanvasHidden(hidden: boolean): void {
  if (typeof document === "undefined") return;
  ensureCurtainStyle();
  const root = document.documentElement;
  if (hidden) root.dataset[SHELL_ATTR] = "1";
  else delete root.dataset[SHELL_ATTR];
}

// 入口默认是四喜首页：模块一被求值就盖上，抢在宿主画布首次绘制之前。
setHostCanvasHidden(true);
