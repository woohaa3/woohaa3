/**
 * 「转为片场」用途偏好（转换模型 + 可选补充要求）
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.6/3.7 / design D1）。
 *
 * 只保存**转换用途**的模型身份与补充要求：它绝不写回源图片/视频节点的生成模型，也不包含
 * 视频本次处理范围（范围属于某段素材，不迁移到另一段视频）。origin-local、版本化键；读取
 * 失败/损坏时回退空设置，写入失败保留最后成功值且不产生「已保存」假象。
 */
import type { FilmSetConversionSettings } from "@woohaa3/contracts";
import { readFilmSetConversionAssistant } from "@woohaa3/contracts";

/** 版本化存储键（结构变化必须提升）。 */
export const FILM_SET_CONVERSION_PREFERENCE_KEY = "woohaa3.film-set.conversion.v1";

/** 可注入的最小 Storage facade（浏览器 localStorage 或测试替身）。 */
export type FilmSetConversionPreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function defaultStorage(): FilmSetConversionPreferenceStorage | null {
  const storage = (globalThis as { localStorage?: FilmSetConversionPreferenceStorage }).localStorage;
  return storage ?? null;
}

/** 规范化偏好：只保留字符串字段，宽度/长度受限；非法整体丢弃（不猜测）。 */
export function normalizeFilmSetConversionPreference(input: unknown): FilmSetConversionSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const settings: FilmSetConversionSettings = {};
  if (typeof record.modelKey === "string" && record.modelKey.length > 0 && (record.modelKey.length <= 200 || readFilmSetConversionAssistant(record.modelKey))) {
    settings.modelKey = record.modelKey;
  }

  return settings;
}

export type FilmSetConversionPreferenceStore = {
  read(): FilmSetConversionSettings;
  /** 合并写入（只覆盖给定字段）；写入失败返回 false，保留最后成功值。 */
  write(patch: FilmSetConversionSettings): boolean;
};

export function createFilmSetConversionPreferenceStore(options: {
  storage?: FilmSetConversionPreferenceStorage | null;
  key?: string;
} = {}): FilmSetConversionPreferenceStore {
  const key = options.key ?? FILM_SET_CONVERSION_PREFERENCE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let current = readInitial();
  function readInitial(): FilmSetConversionSettings {
    if (!storage) return {};
    try {
      const raw = storage.getItem(key);
      return raw ? normalizeFilmSetConversionPreference(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }
  return {
    read: () => current,
    write(patch) {
      const next = { ...current, ...patch };
      if (patch.instruction === undefined) delete next.instruction;
      if (patch.modelKey === undefined) delete next.modelKey;
      current = next;
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(next));
        return true;
      } catch {
        return false;
      }
    }
  };
}
