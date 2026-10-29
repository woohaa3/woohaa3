/**
 * 宿主画布配色跟随四喜主题。
 *
 * 宿主（画布、节点、连线、网格、右下角工具条）的颜色全部来自它自己的 `ctx.theme`
 * （`--app-*` 变量 + Bevy 场景里的同一份 token），与四喜的 antd 主题是两套独立状态：
 * 不接这一层时，四喜切暗色，画布仍是宿主默认的墨绿浅色。
 *
 * 做法：用四喜的 antd 设计 token（与 `SixiProviders` 同一套算法 + `themeTokensFor`）
 * 生成两份宿主 preset，注册成**独立的 `sixi-light` / `sixi-dark`**，外壳挂载期间选过去，
 * 卸载时选回宿主原来那个 id：
 * - 不覆盖宿主自带的 `default` / `dark` —— 那是进程级的主题，宿主的设置面板和别的扩展
 *   （例如 film-set 录制时的背景）都在读它。覆盖它等于让整个宿主的配色变成四喜的。
 * - 代价：宿主启动时按本地记录恢复的是 `sixi-*`，而那时扩展还没注册，恢复失败会回落到内置
 *   浅色，扩展加载后再切到四喜配色 —— 启动时有一瞬间的绿色。这是隔离必须付的成本。
 *
 * 只覆盖界面与画布 chrome；节点类别色（文本蓝 / 图片粉 / 模型青…）、状态色、坐标轴色、
 * 媒体查看器保留宿主原值 —— 它们表达的是"是什么 / 出了什么事"，四喜的黑白灰没有对应档。
 */
import { theme as antdTheme } from "antd";
import {
  APP_THEME_BUILTIN_PRESETS,
  compositeOver,
  themeHexToRgb,
  type AppThemeTokens
} from "@woohaa3/contracts";
import type { ThemeMode } from "@/stores/uiStore";
import { canvasBackdropFor, onPrimaryFor, themeTokensFor } from "@/app/theme";

/** 四喜亮 / 暗对应的宿主 preset id。**不要**复用宿主的 `default` / `dark`（见文件头）。 */
export const HOST_PRESET_ID: Record<ThemeMode, "sixi-light" | "sixi-dark"> = {
  light: "sixi-light",
  dark: "sixi-dark"
};

/**
 * 宿主 preset id → 四喜主题。
 *
 * 同时认宿主内置的 `default` / `dark`：外壳挂载期间用户在宿主设置里点「浅色 / 暗色」也要能
 * 带着四喜切（挂载中的 layout effect 随后会把选择纠正回 `sixi-*`）。别的扩展注册的 preset
 * 返回 null，不跟随。
 */
export function modeOfHostPreset(id: string): ThemeMode | null {
  if (id === HOST_PRESET_ID.light || id === "default") return "light";
  if (id === HOST_PRESET_ID.dark || id === "dark") return "dark";
  return null;
}

type Rgba = { r: number; g: number; b: number; a: number };

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * antd 的颜色有 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` 几种形态。
 * hex 走 contracts 的 `themeHexToRgb`（与宿主校验器同一份实现），这里只补两件它不做的事：
 * 3 位简写（antd 的 `colorTextLightSolid` 就是 `#fff`，contracts 只收 6/8 位）与函数式写法。
 */
function parseColor(value: string): Rgba {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(text);
  const hex = short ? `#${[...short[1]!].map((c) => c + c).join("")}` : text;
  const fromHex = themeHexToRgb(hex);
  if (fromHex) return fromHex;
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const [r, g, b, a = "1"] = fn[1]!.split(",").map((part) => part.trim());
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  }
  throw new Error(`无法解析的颜色：${value}`);
}

const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/**
 * 合成到底色上，输出不透明 `#rrggbb`。
 * 宿主画布 chrome 的 token 在 Bevy 里按 `0xRRGGBB` 读、忽略 alpha，所以半透明的 antd 色
 * （暗色下的文字、填充都是白色带透明度）必须先压到它实际所在的底色上。
 *
 * 底色自己也可能带 alpha（亮色的 `colorFillTertiary` 就是），先把它压到白上 ——
 * 否则会拿一个"半透明的底"去算，结果偏亮。
 */
function opaque(color: string, over: string): string {
  const fg = parseColor(color);
  const bg = compositeOver(parseColor(over), WHITE);
  const { r, g, b } = compositeOver({ ...fg, a: fg.a }, bg);
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** 保留透明度的 `#rrggbbaa`（遮罩、阴影这类本来就该透出下层的 token）。 */
function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseColor(color);
  return `#${byte(r)}${byte(g)}${byte(b)}${byte(alpha * 255)}`;
}

/** 与 `SixiProviders` 完全相同的算法与 token，结果才会和四喜界面上看到的一致。 */
function sixiDesignToken(mode: ThemeMode) {
  return antdTheme.getDesignToken({
    algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: themeTokensFor(mode)
  });
}

/** 交给 `registerPreset` 的原始 preset。指纹由宿主校验时自己算，这里不带。 */
export type HostPreset = { id: string; version: string; tokens: AppThemeTokens };

/** 每档只算一次：`getDesignToken` 要跑完整套 antd 算法，切换时不该重算没变的那一档。 */
const presetCache = new Map<ThemeMode, HostPreset>();

/** 四喜主题 → 完整宿主 preset（未覆盖的 token 取宿主同档内置值）。 */
export function sixiHostPreset(mode: ThemeMode): HostPreset {
  const cached = presetCache.get(mode);
  if (cached) return cached;

  const id = HOST_PRESET_ID[mode];
  // 基底用宿主**同档**的内置 preset：只借用没覆盖的那些 token 的值，id 换成 sixi-*。
  const base = APP_THEME_BUILTIN_PRESETS[mode === "dark" ? "dark" : "default"];
  const t = sixiDesignToken(mode);

  const surface = opaque(t.colorBgContainer, t.colorBgLayout);
  /*
   * 画布底取四喜那边的 `canvasBackdropFor`，不在这里从 antd token 推：
   * 暗色要的是"比页面更深一档"的 `#111111`，antd 没有对应 token（页面底是 `colorBgLayout`）。
   */
  const backdrop = canvasBackdropFor(mode);
  const onSurface = (color: string) => opaque(color, surface);
  const onBackdrop = (color: string) => opaque(color, backdrop);
  const accentSoft = onSurface(t.colorPrimaryBg);
  const onPrimary = opaque(onPrimaryFor(mode), surface);

  const overrides: Partial<AppThemeTokens> = {
    webBackdrop: backdrop,
    webSurface: surface,
    webPanel: surface,
    webElevated: onBackdrop(t.colorBgElevated),
    webSubtle: onSurface(t.colorFillTertiary),
    webTextPrimary: onSurface(t.colorText),
    webTextMuted: onSurface(t.colorTextSecondary),
    // 反色字 / 主色上的字：暗色主色是白，不能用 antd 恒白的 colorTextLightSolid（见 theme.ts onPrimaryFor）
    webTextInverse: onPrimary,
    webBorder: onSurface(t.colorBorder),
    webBorderStrong: onSurface(t.colorTextTertiary),
    webOverlay: withAlpha(t.colorBgMask, parseColor(t.colorBgMask).a),
    webShadow: withAlpha("#000", mode === "light" ? 0.2 : 0.4),

    interactionAccent: onSurface(t.colorPrimary),
    interactionAccentHover: onSurface(t.colorPrimaryHover),
    interactionAccentPressed: onSurface(t.colorPrimaryActive),
    interactionAccentSoft: accentSoft,
    interactionFocus: onSurface(t.colorPrimary),
    interactionOnAccent: onPrimary,
    interactionDisabled: onSurface(t.colorTextDisabled),

    canvasNodeSurface: surface,
    canvasNodeContent: onSurface(t.colorFillTertiary),
    canvasNodeBorder: onSurface(t.colorBorder),
    canvasNodeBorderSelected: onSurface(t.colorPrimary),
    // Bevy 按不透明色画偏移阴影：亮色用浅灰一档，暗色压成底色本身（看起来就是"没有发光的影"）。
    canvasNodeShadow: mode === "light" ? onBackdrop(t.colorBorderSecondary) : backdrop,
    canvasNodeSelectedHalo: accentSoft,
    canvasEdgeDefault: onBackdrop(t.colorTextTertiary),
    canvasEdgeSelected: onBackdrop(t.colorPrimary),
    canvasEdgeDraft: onBackdrop(t.colorPrimary),
    canvasEdgeLabelBackground: backdrop,
    canvasEdgeLabelText: onBackdrop(t.colorTextSecondary),
    canvasPortDefault: onBackdrop(t.colorTextTertiary),
    canvasPortFill: surface,
    canvasResizeHandle: onSurface(t.colorTextSecondary),
    canvasResizeHandleStripe: surface,
    canvasProgressTrack: onSurface(t.colorFillSecondary),
    canvasProgressFill: onSurface(t.colorPrimary),
    canvasCloseIcon: onSurface(t.colorTextTertiary),
    canvasBodyText: onSurface(t.colorTextSecondary),

    // 「未分类」节点原来是墨绿灰，改回四喜的中性灰；有类别的节点保留类别色（见文件头）。
    nodeDefaultForeground: onSurface(t.colorTextSecondary),
    nodeDefaultTint: onSurface(t.colorFillTertiary),

    /*
     * 网格：次线淡、主线强一档。两档取的 token 不一样 —— 亮色的 fill 比 border 淡，
     * 暗色灰阶里正好反过来（`colorFillSecondary` n80 比 `colorBorderSecondary` n90 亮），
     * 照搬亮色的取法暗色会主次颠倒。暗色就用两档描边：n90 → n80，与宿主自己暗色 preset
     * 「只差一档」的关系一致（`#1f2a25` → `#2b3a32`）。
     */
    gridMinor: onBackdrop(mode === "dark" ? t.colorBorderSecondary : t.colorFillSecondary),
    gridMajor: onBackdrop(t.colorBorder),
    gridSelection: onBackdrop(t.colorPrimary)
  };

  const preset: HostPreset = { id, version: base.version, tokens: { ...base.tokens, ...overrides } };
  presetCache.set(mode, preset);
  return preset;
}
