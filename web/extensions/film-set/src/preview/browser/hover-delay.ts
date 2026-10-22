/**
 * hover 开播的单调延迟（ms）。
 *
 * 保留一个很短的防误触窗口，同时让指针进入合法动态预览内容区后几乎立即从 T=0 循环开播
 * （design D6）。改这里即可整体调节等待时长。
 */
export const HOVER_PLAYBACK_DELAY_MS = 120;

/** One cancellable deadline in the extension scope, using monotonic time. */
export class HoverPlaybackDelay {
  private key: string | null = null;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private readonly wake: () => void, private readonly clock = {
    now: () => performance.now(),
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
  }) {}
  sync(key: string | null): boolean {
    if (this.disposed) return false;
    if (key !== this.key) {
      this.cancel();
      this.key = key;
      this.deadline = this.clock.now() + HOVER_PLAYBACK_DELAY_MS;
    }
    if (key === null) return false;
    const remaining = this.deadline - this.clock.now();
    if (remaining <= 0) return true;
    if (this.timer === null) {
      const generation = this.generation;
      this.timer = this.clock.set(() => {
        if (this.disposed || generation !== this.generation) return;
        this.timer = null;
        this.wake(); // Read latest candidate/owner before any compilation or publication.
      }, remaining);
    }
    return false;
  }
  cancel(): void {
    this.generation++;
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
    this.key = null;
  }
  dispose(): void { this.cancel(); this.disposed = true; }
}
