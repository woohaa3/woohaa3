/**
 * Canvas Runtime 的动画播放投影持有器
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只持浏览器本地动画播放投影与播放头接收器；不写规范状态。`set` 时把播放头转发给片场媒体
 * 会话，使所有视频/对象动作跟随同一时间。
 */
import type { BevyAnimationPlayback } from "@woohaa3/contracts";

type TimeSink = (input: { nodeId: string | null; time: number; playing: boolean }) => void;

export class AnimationPlaybackStore {
  private playback: BevyAnimationPlayback | null = null;
  private timeSink: TimeSink | null = null;
  private compositeAssetMedia: import("./composite-asset-media-session.js").CompositeAssetMediaSessions | null = null;

  setTimeSink(sink: TimeSink | null): void {
    this.timeSink = sink;
  }

  setCompositeAssetMediaSessions(sessions: import("./composite-asset-media-session.js").CompositeAssetMediaSessions | null): void {
    this.compositeAssetMedia = sessions;
  }

  compositeAssetMediaSessions(): import("./composite-asset-media-session.js").CompositeAssetMediaSessions | null {
    return this.compositeAssetMedia;
  }

  notify(input: { nodeId: string | null; time: number; playing: boolean }): void {
    this.timeSink?.(input);
  }

  set(playback: BevyAnimationPlayback | null): boolean {
    if (this.playback === playback) return false;
    this.playback = playback;
    this.notify({
      nodeId: playback?.nodeId ?? null,
      time: playback?.time ?? 0,
      playing: playback?.playing ?? false
    });
    return true;
  }

  current(): BevyAnimationPlayback | null {
    return this.playback;
  }
}
