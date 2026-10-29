/**
 * 拍摄镜头背景校验（自 `film-set-animations.ts` 拆出的轻量模块）。
 *
 * 拆出原因：`film-set-group.ts` 只需要背景校验，若从 `film-set-animations.ts` 运行时导入会把
 * `canvas-node-model → render-scene → scene-builder → film-set-group` 的循环带回来，导致
 * `readFilmSetGroupMarker` 在循环初始化期间是 undefined。本模块只依赖纯字符串规则，不引入
 * 任何画布模型/渲染依赖。
 */
export const FILM_SET_BACKDROP_THEME = "theme" as const;
export type FilmSetBackdrop = typeof FILM_SET_BACKDROP_THEME | string;
/** 严格六位十六进制（大写统一为小写；与渲染侧 `parse_hex` 一致）。 */
const BACKDROP_HEX = /^#[0-9a-f]{6}$/;

/**
 * 校验并规范化镜头背景（D6）。
 *
 * 缺失 / `theme` → `undefined`（不写入规范数据，旧镜头身份不变）；自定义色只接受六位
 * `#rrggbb`（统一小写）。其它值（`#0008`、颜色名、3 位短写）一律拒绝，不静默回退。
 */
export function readFilmSetBackdrop(input: unknown): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== "string") return { ok: false, reason: "backdrop 必须是字符串" };
  if (input === FILM_SET_BACKDROP_THEME) return { ok: true, value: undefined };
  const normalized = input.trim().toLowerCase();
  if (!BACKDROP_HEX.test(normalized)) {
    return { ok: false, reason: "backdrop 必须是 theme 或六位十六进制颜色（如 #000000）" };
  }
  return { ok: true, value: normalized };
}

/** 镜头背景是否已显式设为自定义颜色。 */
export function filmSetBackdropIsCustom(clip: { backdrop?: string }): boolean {
  return typeof clip.backdrop === "string" && clip.backdrop !== FILM_SET_BACKDROP_THEME;
}
