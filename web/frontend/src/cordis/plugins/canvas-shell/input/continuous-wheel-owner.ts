export const WHEEL_OWNER_IDLE_MS = 200;
export type WheelInputOwner = "canvas" | "native" | "blocked";

export class ContinuousWheelOwner<T> {
  private session: { owner: WheelInputOwner; target: T | null; lastAt: number } | null = null;

  resolve(now: number, start: () => { owner: WheelInputOwner; target: T | null }): { owner: WheelInputOwner; target: T | null; started: boolean } {
    if (this.session && now - this.session.lastAt >= WHEEL_OWNER_IDLE_MS) this.session = null;
    const started = this.session === null;
    if (!this.session) this.session = { ...start(), lastAt: now };
    else this.session.lastAt = now;
    return { ...this.session, started };
  }

  reset(): void { this.session = null; }
}

export function nativeWheelTarget(target: EventTarget | null, panel: Element): Element | null {
  if (!(target instanceof Element) || !panel.contains(target)) return null;
  const control = target.closest("input, textarea, select, [contenteditable='true'], [data-wheel-native], [role='menu'], [data-radix-scroll-area-viewport]");
  if (control && panel.contains(control)) return control;
  for (let current: Element | null = target; current && panel.contains(current); current = current.parentElement) {
    if (current === panel) break;
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)
      && (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)) return current;
  }
  return null;
}
