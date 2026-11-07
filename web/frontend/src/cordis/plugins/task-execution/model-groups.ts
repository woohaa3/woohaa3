/**
 * 模型选择器的一级分类：服务端模板的运营分类（`category`）→ 系列名。
 *
 * 命名与 PS 插件「AI智能体」页一致（`workflow-list-sixi.tsx` 的 `API_TOOL_ENTRIES`），
 * 两边叫同一个名字。分类带后缀（`image-21` / `video-s25`…），按精确值查；
 * 查不到的不丢模型，由选择器归到「其他」。
 */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  image: "BananaPro",
  "image-2": "Banana2",
  "image-21": "Banana2.1",
  "image-g": "GPT-Image2",
  "image-g25": "GPT-Image2.5",
  "image-s": "豆包5.0Pro",
  "image-z": "图片增强",
  "image-y": "图片去水印",
  "image-k": "图片扩展",
  "video-s": "Seedance",
  "video-s25": "Seedance2.5",
  "video-v": "Veo",
  "video-m": "HappyHorse",
  "video-h3": "MiniMax H3",
  "video-w": "Wan",
  "video-h": "海螺",
  "video-k": "可灵"
};

/** 目录模型 `capabilities.category` → 一级分类名；没有分类或不认识返回 undefined。 */
export function modelGroupLabel(capabilities: Record<string, unknown> | undefined): string | undefined {
  const category = capabilities?.category;
  if (typeof category !== "string") return undefined;
  return GROUP_LABELS[category.trim().toLowerCase()];
}

/** 内部模板(扩展自己用,如局部修改的拼合直通)的运营分类;不该出现在用户的模型下拉里 */
const INTERNAL_CATEGORY = "sixi-internal";

export function isInternalModel(capabilities: Record<string, unknown> | undefined): boolean {
  return capabilities?.category === INTERNAL_CATEGORY;
}
