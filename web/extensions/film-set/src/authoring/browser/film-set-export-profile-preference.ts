import { DEFAULT_FILM_SET_EXPORT_PROFILE, filmSetExportProfileLabel, readFilmSetExportProfile, type FilmSetExportProfile } from "@woohaa3/contracts";

/**
 * 「生成视频」的 profile 本地偏好（change: 2026-10-19-extend-film-set-for-motion-graphics，D7）。
 *
 * 只存在浏览器本地，不写片场节点、不改变内容身份；缺省 `standard` 与改动前一致。
 * 存储不可用（隐私模式/无 localStorage）时静默退回默认值，不影响导出。
 */
export const EXPORT_PROFILE_STORAGE_KEY = "woohaa.film-set.export-profile";

export function readExportProfilePreference(storage?: Pick<Storage, "getItem"> | null): FilmSetExportProfile {
  try {
    return readFilmSetExportProfile((storage ?? globalThis.localStorage)?.getItem(EXPORT_PROFILE_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_FILM_SET_EXPORT_PROFILE;
  }
}

export function writeExportProfilePreference(
  profile: FilmSetExportProfile,
  storage?: Pick<Storage, "setItem"> | null
): FilmSetExportProfile {
  try {
    (storage ?? globalThis.localStorage)?.setItem(EXPORT_PROFILE_STORAGE_KEY, profile);
  } catch {
    // 本地偏好不是必需能力：写失败不打断导出。
  }
  return profile;
}

/** 选择器的可选项标签（缺省项明确标注）。 */
export const EXPORT_PROFILE_OPTIONS = [
  { value: "standard" as const, label: `${filmSetExportProfileLabel("standard")}（720p，缺省）` },
  { value: "hd" as const, label: `${filmSetExportProfileLabel("hd")}（1080p）` },
  { value: "hd60" as const, label: `${filmSetExportProfileLabel("hd60")}（1080p 流畅动效）` }
];
