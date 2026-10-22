/**
 * Theme Service（change: unify-application-theme-tokens，任务 2.1 / design D3/D6/D7）。
 *
 * 页面级唯一主题 owner：
 * - 持有当前合法 `AppThemeSnapshot`（原子替换，不得逐 token 异步更新）；
 * - 缺省注册产品内置浅色（default）与暗色（dark）preset；
 * - 把 snapshot 投影为根容器上的 `--app-*` CSS variables，并同步 `color-scheme` /
 *   `data-app-theme`（同一提交内完成，无混色中间态）；
 * - 非法 preset / 非法本地选择保留上一合法主题并产生稳定诊断；
 * - 选择是**浏览器本地展示状态**：不写 Y.Doc / canvas 命令 / 任务 API；
 * - `dispose` 撤销订阅，不遗留 document 级监听或迟到更新。
 *
 * 本服务不依赖 React；Provider 只是把 `applyTo` 接到 React 生命周期。
 */
import {
  APP_THEME_BUILTIN_PRESETS,
  APP_THEME_CSS_VARIABLES,
  APP_THEME_TOKEN_NAMES,
  appThemeAppearance,
  defaultAppTheme,
  validateAppThemePreset,
  type AppThemeSnapshot
} from "@woohaa3/contracts";
import type { ThemeService } from "../../contracts.js";

/** 本地主题选择存储键（只存 preset id；不写任何 canvas 状态）。 */
export const THEME_SELECTION_STORAGE_KEY = "woohaa3-app-theme-selection";

/** 可被本地选择引用的内置 preset（id → 未知 preset 输入）。 */
export type ThemePresetRegistry = Record<string, unknown>;

export type ThemeServiceOptions = {
  /** 初始 preset；缺省用内置默认主题。 */
  initial?: unknown;
  /** 本地持久化（localStorage）；缺省读取 `globalThis.localStorage`。测试可注入。 */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /**
   * 可被本地选择恢复的具名 preset。
   *
   * 缺省注册产品内置 `default` + `dark`；显式提供时由调用方负责注册表内容
   * （测试/showcase 的 sentinel 等）。
   */
  presets?: ThemePresetRegistry;
  /** 是否从本地存储恢复选择（缺省 true）。 */
  restore?: boolean;
};

export class AppThemeService implements ThemeService {
  private snapshot: AppThemeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly roots = new Set<HTMLElement>();
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private readonly presets: ThemePresetRegistry;
  private lastDiagnostic: string | null = null;
  private disposed = false;

  constructor(options: ThemeServiceOptions = {}) {
    const initialInput = options.initial ?? defaultAppTheme();
    const initial = validateAppThemePreset(initialInput);
    if (!initial.ok) {
      throw new Error(`初始 theme preset 非法：${initial.code} ${initial.error}`);
    }
    this.snapshot = initial.theme;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    // 内置暗色 preset 随产品构建发布；显式注入 presets 的调用方（测试/showcase）自行负责
    // 注册表内容，避免把测试注册表与产品主题混在一起。
    this.presets =
      options.presets === undefined
        ? { default: initialInput, dark: APP_THEME_BUILTIN_PRESETS.dark }
        : { default: initialInput, ...options.presets };
    if (options.restore ?? true) this.restoreSelection();
  }

  getSnapshot = (): AppThemeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  diagnostic = (): string | null => this.lastDiagnostic;

  /** 用完整 preset 原子替换；非法输入整体拒绝并保留上一主题。 */
  setPreset(preset: unknown): { ok: true } | { ok: false; error: string } {
    if (this.disposed) return { ok: false, error: "theme service 已释放" };
    const result = validateAppThemePreset(preset);
    if (!result.ok) {
      const error = `${result.code}: ${result.error}`;
      this.lastDiagnostic = error;
      return { ok: false, error };
    }
    this.lastDiagnostic = null;
    this.snapshot = result.theme;
    this.persistSelection(this.snapshot.id);
    // 一次性写入所有根容器并通知订阅者：单线程下同一提交内完成，Web/Bevy 不出现混色帧。
    this.applyAllRoots();
    for (const listener of this.listeners) listener();
    return { ok: true };
  }

  /** 按 id 选择已注册 preset；未知 id 失败并保留上一主题。 */
  select(presetId: string): { ok: true } | { ok: false; error: string } {
    const registered = this.presets[presetId];
    if (!registered) {
      const error = `未知主题 preset：${presetId}`;
      this.lastDiagnostic = error;
      return { ok: false, error };
    }
    return this.setPreset(withId(registered, presetId));
  }

  /** 注册一个可由本地选择引用的具名 preset（不改变当前主题）。 */
  registerPreset(presetId: string, preset: unknown): void {
    this.presets[presetId] = withId(preset, presetId);
  }

  presetIds = (): readonly string[] => Object.keys(this.presets);

  /** 把当前 snapshot 写到主题根容器；返回撤销函数（移除挂载但保留变量）。 */
  applyTo(root: HTMLElement): () => void {
    if (this.disposed) return () => undefined;
    this.roots.add(root);
    applyThemeState(root, this.snapshot);
    return () => {
      this.roots.delete(root);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.roots.clear();
  }

  private applyAllRoots(): void {
    for (const root of this.roots) applyThemeState(root, this.snapshot);
  }

  private restoreSelection(): void {
    if (!this.storage) return;
    let stored: string | null = null;
    try {
      stored = this.storage.getItem(THEME_SELECTION_STORAGE_KEY);
    } catch {
      return;
    }
    if (!stored) return;
    const result = this.select(stored);
    if (!result.ok) {
      // 非法本地选择：保留默认主题，清除坏值避免反复失败。
      try {
        this.storage.removeItem(THEME_SELECTION_STORAGE_KEY);
      } catch {
        /* 忽略存储不可用 */
      }
    }
  }

  private persistSelection(id: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(THEME_SELECTION_STORAGE_KEY, id);
    } catch {
      /* 存储不可用时主题仍在内存中生效 */
    }
  }
}

/**
 * 把 snapshot 完整写到根容器：CSS variables + `color-scheme` + `data-app-theme`。
 *
 * `data-app-theme` 让首帧内联引导脚本（`web/frontend/index.html`）在 React 启动前就能命中
 * `generated-theme.css` 的暗色块；运行时再写入同一属性，刷新与切换走同一语义。
 */
export function applyThemeState(root: HTMLElement, theme: AppThemeSnapshot): void {
  writeTokens(root, theme);
  const appearance = appThemeAppearance(theme);
  root.style.colorScheme = appearance;
  if (root.dataset) root.dataset.appTheme = appearance;
}

/** 把 snapshot 写入一个根容器（一次性设置所有 `--app-*`）。 */
export function writeTokens(root: HTMLElement, theme: AppThemeSnapshot): void {
  for (const name of APP_THEME_TOKEN_NAMES) {
    root.style.setProperty(APP_THEME_CSS_VARIABLES[name], theme.tokens[name]);
  }
}

/** snapshot → `{ "--app-*": value }` 映射（供 SSR / 测试 / 非 DOM 消费）。 */
export function themeCssVariables(theme: AppThemeSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of APP_THEME_TOKEN_NAMES) out[APP_THEME_CSS_VARIABLES[name]] = theme.tokens[name];
  return out;
}

function withId(preset: unknown, id: string): unknown {
  if (typeof preset === "object" && preset !== null) {
    return { ...(preset as Record<string, unknown>), id };
  }
  return preset;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
