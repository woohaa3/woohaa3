/**
 * Canvas Runtime 的动画播放投影持有器
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只持浏览器本地动画播放投影；不写规范状态。
 */
import type { BevyAnimationPlayback } from "@woohaa3/contracts";

export class AnimationPlaybackStore {
  private playback: BevyAnimationPlayback | null = null;

  set(playback: BevyAnimationPlayback | null): boolean {
    if (this.playback === playback) return false;
    this.playback = playback;
    return true;
  }

  current(): BevyAnimationPlayback | null {
    return this.playback;
  }
}
