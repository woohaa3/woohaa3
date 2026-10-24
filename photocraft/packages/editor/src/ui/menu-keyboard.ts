/**
 * 菜单栏键盘导航（I037）。
 *
 * 复刻上游 Web 菜单栏的**键盘操作**：点按 Alt 或按 F10 把键盘放到顶级菜单栏，左右键切换
 * 顶级项，向下/Enter/Space 打开，Esc 或点击离开，Alt+字母直达对应菜单。这里不新增
 * 读屏/ARIA 契约（不在本项目验收范围），也不复制上游的菜单项级助记键：界面文案固定中文
 * （I216），没有可用的拉丁字母供菜单行助记键使用，强行造字母会与真实文案不符。
 *
 * 全部是纯函数，DOM 只负责把按钮顺序和标签传进来。
 */

/** 顶级菜单的稳定助记字母；与上游 TOP_PREFERRED 的 Photoshop 习惯一致。 */
const TOP_MNEMONICS: Readonly<Record<string, string>> = {
  "文件": "F", "编辑": "E", "图像": "I", "图层": "L", "文字": "Y",
  "选择": "S", "视图": "V", "窗口": "W", "帮助": "H"
};

/**
 * 菜单标签的助记字母：优先用已知顶级菜单映射，否则取标签中第一个拉丁字母；
 * 纯中文且不在映射内的菜单没有助记键（返回 null），不伪造。
 */
export function menuMnemonic(label: string): string | null {
  const known = TOP_MNEMONICS[label];
  if (known) return known;
  const latin = /[A-Za-z]/.exec(label);
  return latin ? latin[0]!.toUpperCase() : null;
}

/** 顶级菜单在给定下标集合内循环移动。 */
export function moveMenuFocus(index: number, count: number, delta: -1 | 1): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}

export type MenuBarKey = {key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number};
export type MenuBarAction =
  | {kind: "focus"; index: number}
  | {kind: "move"; delta: -1 | 1}
  | {kind: "open"}
  | {kind: "leave"}
  | {kind: "mnemonic"; letter: string}
  | {kind: "ignore"};

/**
 * 解析菜单栏按键。
 *
 * `focused` 表示键盘当前停在顶级菜单栏且没有展开的菜单。菜单展开后所有按键都交给
 * Radix 的菜单语义（方向键/Home/End/Enter/Escape/typeahead），本层不重复实现。
 */
export function resolveMenuBarKey(event: MenuBarKey, focused: boolean, menuOpen: boolean): MenuBarAction {
  if (event.isComposing || event.keyCode === 229) return {kind: "ignore"};
  // F10 始终可以把键盘放到菜单栏或离开它（与上游一致）。
  if (event.key === "F10") return focused ? {kind: "leave"} : {kind: "focus", index: 0};
  if (menuOpen) return {kind: "ignore"};
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && !mod && !event.shiftKey) {
    const letter = event.code?.startsWith("Key") ? event.code.slice(3) : event.key.length === 1 ? event.key.toUpperCase() : "";
    if (/^[A-Z]$/.test(letter)) return {kind: "mnemonic", letter};
    return {kind: "ignore"};
  }
  if (!focused) return {kind: "ignore"};
  if (event.key === "ArrowLeft") return {kind: "move", delta: -1};
  if (event.key === "ArrowRight") return {kind: "move", delta: 1};
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") return {kind: "open"};
  if (event.key === "Escape") return {kind: "leave"};
  return {kind: "ignore"};
}

/**
 * Alt 点按判定：按下 Alt 后没有再按其他键就松开，才算一次「点按 Alt」。
 * 按住 Alt 再按字母不属于点按，避免和 Alt+字母助记键冲突。
 */
export class AltTap {
  private down = false;
  private clean = false;

  keydown(event: {key: string; repeat?: boolean}): void {
    if (event.key === "Alt") {
      if (!this.down) this.clean = true;
      this.down = true;
      return;
    }
    if (this.down) this.clean = false;
  }

  /** 返回本次 Alt 是否构成点按，并复位。 */
  keyup(event: {key: string}): boolean {
    if (event.key !== "Alt") return false;
    const tap = this.down && this.clean;
    this.down = false;
    this.clean = false;
    return tap;
  }

  reset(): void {
    this.down = false;
    this.clean = false;
  }
}
