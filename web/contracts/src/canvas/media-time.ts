/** Common timeline-to-media mapping used by asset adapters and texture sessions. */
export type ModelMediaTimeMap = { startTime: number; duration: number; timeScale: number; loop: boolean };
export const DEFAULT_MEDIA_TIME_MAP: ModelMediaTimeMap = { startTime: 0, duration: 0, timeScale: 1, loop: false };
/**
 * 统一播放头到对象局部时间映射（design D4；Rust 采用同一公式）。
 *
 * 返回 `null` 表示尚未开始（显示基础姿态，不执行 child motion）。
 */
export function mediaTimelineLocalTime(playback: ModelMediaTimeMap | undefined, T: number): number | null {
  const config = playback ?? DEFAULT_MEDIA_TIME_MAP;
  const time = Number.isFinite(T) ? Math.max(0, T) : 0;
  if (time < config.startTime) return null;
  const u = (time - config.startTime) * config.timeScale;
  if (!(config.duration > 0)) return 0;
  if (config.loop) return ((u % config.duration) + config.duration) % config.duration;
  return Math.min(Math.max(u, 0), config.duration);
}

