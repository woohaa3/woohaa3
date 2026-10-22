/**
 * 片场显式导出的 profile（change: 2026-10-19-extend-film-set-for-motion-graphics，D7）。
 *
 * 浏览器导出与原生录制共用这一份定义：短边、帧率与码率只有此处一份，长边按镜头画幅计算并取
 * 偶数。镜头参考视频固定 `standard`，不随显式导出选择变化。
 *
 * 纯常量与纯函数：可在浏览器、Node 与扩展里复用。
 */

/** 导出 profile 标识。 */
export const FILM_SET_EXPORT_PROFILES = ["standard", "hd", "hd60"] as const;
export type FilmSetExportProfile = (typeof FILM_SET_EXPORT_PROFILES)[number];

/** 缺省 profile：与改动前的 720p30/4Mbps 完全一致。 */
export const DEFAULT_FILM_SET_EXPORT_PROFILE: FilmSetExportProfile = "standard";

/** 每个 profile 的短边、帧率与码率（唯一事实来源）。 */
export const FILM_SET_EXPORT_PROFILE_SPECS: Record<FilmSetExportProfile, { shortEdge: number; frameRate: number; bitrate: number }> = {
  standard: { shortEdge: 720, frameRate: 30, bitrate: 4_000_000 },
  hd: { shortEdge: 1080, frameRate: 30, bitrate: 8_000_000 },
  hd60: { shortEdge: 1080, frameRate: 60, bitrate: 12_000_000 }
};

export function isFilmSetExportProfile(value: unknown): value is FilmSetExportProfile {
  return typeof value === "string" && (FILM_SET_EXPORT_PROFILES as readonly string[]).includes(value);
}

/** 缺省 profile（非法/缺失输入回退 `standard`，供 UI 本地偏好读取）。 */
export function readFilmSetExportProfile(value: unknown): FilmSetExportProfile {
  return isFilmSetExportProfile(value) ? value : DEFAULT_FILM_SET_EXPORT_PROFILE;
}

/**
 * 按镜头画幅与 profile 计算输出尺寸：短边由 profile 决定，长边保持画幅并取偶数。
 *
 * 与改动前的 `videoSize` 规则逐位一致（`round(short*ratio/2)*2`），只把短边参数化。
 */
export function filmSetExportVideoSize(aspect: string, profile: FilmSetExportProfile = DEFAULT_FILM_SET_EXPORT_PROFILE): { width: number; height: number } {
  const shortEdge = FILM_SET_EXPORT_PROFILE_SPECS[profile].shortEdge;
  const [width, height] = aspect.split(":").map(Number);
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  return ratio >= 1
    ? { width: Math.round((shortEdge * ratio) / 2) * 2, height: shortEdge }
    : { width: shortEdge, height: Math.round(shortEdge / ratio / 2) * 2 };
}

/** profile 的帧率。 */
export function filmSetExportFrameRate(profile: FilmSetExportProfile = DEFAULT_FILM_SET_EXPORT_PROFILE): number {
  return FILM_SET_EXPORT_PROFILE_SPECS[profile].frameRate;
}

/** profile 的目标码率。 */
export function filmSetExportBitrate(profile: FilmSetExportProfile = DEFAULT_FILM_SET_EXPORT_PROFILE): number {
  return FILM_SET_EXPORT_PROFILE_SPECS[profile].bitrate;
}

/** profile 的用户可读标签（界面选择器与活动浮层共用）。 */
export function filmSetExportProfileLabel(profile: FilmSetExportProfile): string {
  const spec = FILM_SET_EXPORT_PROFILE_SPECS[profile];
  return profile === "standard" ? `720p${spec.frameRate}` : `1080p${spec.frameRate}`;
}
