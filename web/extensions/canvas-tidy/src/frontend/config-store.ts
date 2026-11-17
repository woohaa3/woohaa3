/**
 * 宿主配置的读取（前端侧，只读）。
 *
 * 配置的**真源在宿主**：值落在宿主配置文件的 `extensions.canvas-tidy.*` 段，设置页由宿主按
 * `shared.ts` 的 `Config` 声明自动生成表单并写入。前端只**读**：启动读一次、页面重新可见时补一次、
 * 每次整理前再读一次，然后交给规划函数。
 *
 * 为什么前端不写：设置界面已经由宿主统一提供（逐项保存、范围校验、写回配置文件、热重载）。
 * 扩展再写一遍就成了第二套写入路径，两边对「合法值」「何时生效」的判断迟早分叉。
 *
 * 不做 localStorage 兜底缓存：配置是宿主事实，本机缓存一份只会在「配置文件被手工改回去」时
 * 显示过时值。读到之前的短暂空窗用声明里的 default 顶上。
 */
import type { SettingsEntryView } from "@woohaa3/contracts";
import { resolvePublicUrl } from "@woohaa3/frontend/extension-api";
import { CANVAS_TIDY_CONFIG_PREFIX } from "../shared.js";
import type { CanvasTidyConfigValues } from "../shared.js";

/** 配置缺失时的兜底值：与 `shared.ts` 里每个字段的 `default` 保持一致。 */
export const FALLBACK_CONFIG: CanvasTidyConfigValues = {
  gap: 40,
  columnGapRatio: 250,
  shrinkOversized: true,
  maxCardScale: 100,
  revealAfterTidy: true
};

export type TidyConfigSnapshot = {
  values: CanvasTidyConfigValues;
  /** 是否已成功读到宿主配置（false 时 `values` 是兜底值）。 */
  loaded: boolean;
  error: string | null;
};

const KEY_TO_FIELD: Record<string, keyof CanvasTidyConfigValues> = {
  [`${CANVAS_TIDY_CONFIG_PREFIX}.gap`]: "gap",
  [`${CANVAS_TIDY_CONFIG_PREFIX}.columnGapRatio`]: "columnGapRatio",
  [`${CANVAS_TIDY_CONFIG_PREFIX}.shrinkOversized`]: "shrinkOversized",
  [`${CANVAS_TIDY_CONFIG_PREFIX}.maxCardScale`]: "maxCardScale",
  [`${CANVAS_TIDY_CONFIG_PREFIX}.revealAfterTidy`]: "revealAfterTidy"
};

/** 从设置快照的条目里投影出本扩展的配置值（未知/缺失键用兜底值）。 */
export function projectTidyConfig(entries: readonly SettingsEntryView[]): CanvasTidyConfigValues {
  const values: CanvasTidyConfigValues = { ...FALLBACK_CONFIG };
  for (const entry of entries) {
    const field = KEY_TO_FIELD[entry.key];
    if (!field || entry.value === null) continue;
    if (field === "shrinkOversized" || field === "revealAfterTidy") {
      if (typeof entry.value === "boolean") values[field] = entry.value;
      continue;
    }
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) values[field] = entry.value;
  }
  return values;
}

export type TidyConfigStore = {
  getSnapshot(): TidyConfigSnapshot;
  subscribe(listener: () => void): () => void;
  /** 重新读一次宿主配置。 */
  refresh(): Promise<void>;
  dispose(): void;
};

/**
 * 读 `/api/settings` 取本扩展那几节的值。
 *
 * 设置 API 没有推送通道，所以这里只在明确的时机主动读（启动 / 页面重新可见 / 每次整理前），
 * 不做常驻轮询——整理是低频动作，轮询设置接口的代价比「慢一拍」大得多。
 */
export function createTidyConfigStore(): TidyConfigStore {
  let snapshot: TidyConfigSnapshot = { values: { ...FALLBACK_CONFIG }, loaded: false, error: null };
  const listeners = new Set<() => void>();
  let disposed = false;
  const emit = () => { for (const listener of listeners) listener(); };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      const response = await fetch(resolvePublicUrl("/api/settings"), { headers: { accept: "application/json" } });
      if (!response.ok) {
        // 设置面不可用（只读部署 / 未授权）：保留兜底值并记下原因，不抛错打断整理。
        if (disposed) return;
        snapshot = { values: snapshot.values, loaded: false, error: `配置读取失败（${response.status}）` };
        emit();
        return;
      }
      const body = (await response.json().catch(() => null)) as { settings?: unknown } | null;
      const entries = Array.isArray(body?.settings) ? body.settings as SettingsEntryView[] : [];
      if (disposed) return;
      snapshot = { values: projectTidyConfig(entries), loaded: true, error: null };
      emit();
    } catch {
      if (disposed) return;
      snapshot = { values: snapshot.values, loaded: false, error: "无法连接配置服务" };
      emit();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    dispose() {
      disposed = true;
      listeners.clear();
    }
  };
}
