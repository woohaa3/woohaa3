/**
 * 工具栏槽位注册表（change: refactor-photocraft-toolbar，design D1）。
 *
 * 结构逐项对应上游 `crates/ui-egui/src/panels.rs::TOOL_SECTIONS`：**段顺序、槽索引、槽内成员
 * 顺序全部照抄**，不在本模块里重排或合并。逐项核对见
 * `openspec/changes/refactor-photocraft-toolbar/notes/toolbar-interaction-inventory.md`，
 * 机械比对见 `tests/fixtures/toolbar-slots.json` 与 `toolbar-slots.test.ts`。
 *
 * 三件事必须分开保真（上游也是这样）：
 * - **槽内顺序**决定 flyout 列表顺序；
 * - **循环顺序**（`cycleOrder`，取上游 `Tool::ALL` 下标）决定字母键在组内的循环次序；
 *   槽 3 与槽 16 的这两者不同，不能用一个数组兼任；
 * - **子工具变体**（`variant`）是同一工具 id 的不同模式（选框的矩形/椭圆/行列、文字的横排/竖排）：
 *   选中它只切换变体，不换工具 id，因此不重复占用字母组。
 *
 * 未开放成员用 `unsupported` 标注理由后保留在表里：支持范围扩大时只改标注，不重抄结构；
 * 界面只渲染没有 `unsupported` 的成员。
 */
import type { JSX } from "react";
import type { PhotoEditorTool } from "./photo-editor-shortcuts.js";
import type { UiIconProps } from "./ui/icons.js";
import {
  BandageIcon, BrushIcon, DropletsIcon, EraserIcon, FlameIcon, HistoryIcon, LassoIcon,
  MarqueeIcon, MoveIcon, PaintBucketIcon, PaletteIcon, PenIcon, PencilIcon, PipetteIcon,
  ScanEyeIcon, SparklesIcon, StampIcon, SunMediumIcon, SyringeIcon, TypeIcon, WandIcon,
  WavesIcon, WindIcon, ZoomInIcon
} from "./ui/icons.js";

type Icon = (props: UiIconProps) => JSX.Element;

/** 槽位里的一个成员。 */
export type ToolMember = {
  /** 槽内唯一标识；同一工具的不同变体各有自己的 id。 */
  id: string;
  /** 选中后激活的工具。 */
  tool: PhotoEditorTool;
  /** 上游 `Tool` 枚举名，用于与 `tests/fixtures/toolbar-slots.json` 机械比对。 */
  upstream: string;
  label: string;
  Icon: Icon;
  /** 组键；`null` 表示不参与任何字母循环（上游 `Tool::key()` 返回 `'\0'`）。 */
  key: string | null;
  /** 上游 `Tool::ALL` 下标，决定组内循环次序。 */
  cycleOrder: number;
  /** 同一工具的子工具变体标识；选中时把该变体设到工具上，而不是换工具。 */
  variant?: string;
  /** 未开放时的产品/平台理由；有它就不渲染、不入组、不进命令面板。 */
  unsupported?: string;
};

/** 一个槽位：`index` 是它在 `TOOL_SECTIONS` 中的原始下标，flyout 身份与记忆键都用它。 */
export type ToolSlot = {
  index: number;
  /** 段号；相邻段之间画分隔线。 */
  section: number;
  members: readonly ToolMember[];
};

const open = (id: string, tool: PhotoEditorTool, upstream: string, label: string, Icon: Icon, key: string | null, cycleOrder: number, variant?: string): ToolMember =>
  ({id, tool, upstream, label, Icon, key, cycleOrder, ...(variant === undefined ? {} : {variant})});

const shut = (id: string, tool: PhotoEditorTool, upstream: string, label: string, Icon: Icon, key: string | null, cycleOrder: number, unsupported: string): ToolMember =>
  ({id, tool, upstream, label, Icon, key, cycleOrder, unsupported});

/* 未开放理由：与差异矩阵对应条目一致，改动时两处一起改。 */
const R_ARTBOARD = "画板需要新的持久化组结构与相邻画板语义（I024）";
const R_CROP = "裁剪需要画布裁切框手势与裁切文档状态（I027）";
const R_PERSPECTIVE_CROP = "透视裁切需要四点/透视四边形手势（I003）";
const R_SLICE = "切片需要文档级 slice 状态与 HTML/图像批量交付（I002）";
const R_FRAME = "Frame 需要可接收图层内容的占位框组语义（I025）";
const R_VECTOR = "矢量路径与形状属关闭能力（I026）";
const R_TYPE_MASK = "文字蒙版需要新建时把字形转成选区，未协商该写入口（I115 相邻项）";
const R_OBJECT_SELECTION = "对象选择需要内容识别分割，本产品未开放该内核能力";
const R_QUICK_SELECTION = "快速选择需要按笔划增长的分割查询，本产品未开放该内核能力";
const R_COLOR_SAMPLER = "颜色取样点需要跨工具持久的取样标记状态（I159 相邻项）";
const R_RULER = "量尺工具需要画布量尺与测量记录状态（I160 相邻项）";
const R_NOTE = "注释工具需要文档级注释持久化，本产品未协商";
const R_COUNT = "计数工具需要文档级计数标记，本产品未协商";
const R_GRADIENT = "Gradient 工具依赖填充层与渐变编辑器（I164/I165）";
const R_REMOVE = "Remove 需要暂存笔划与内容填补任务（I016）";
const R_PATCH = "Patch 需要选区拖动取样手势（I013）";
const R_CONTENT_AWARE_MOVE = "内容感知移动需要放置后变换与填补任务（I014）";
const R_ROTATE_VIEW = "画布视图旋转未开放，视口仅保存平移/缩放（I090）";
const R_PEN = "路径工具依赖关闭的矢量能力（I026）";
const R_SHAPE = "形状工具依赖关闭的矢量能力（I026）";

/**
 * 全部槽位，顺序与上游 `TOOL_SECTIONS` 完全一致：5 段 21 槽 67 成员。
 * 不支持成员也在表内（带 `unsupported`），投影时再过滤。
 */
export const TOOL_SLOTS: readonly ToolSlot[] = [
  // 段 1
  {index: 0, section: 1, members: [
    open("move", "move", "Move", "移动", MoveIcon, "V", 0),
    shut("artboard", "move", "Artboard", "画板", MoveIcon, "V", 1, R_ARTBOARD)
  ]},
  // 段 2
  {index: 1, section: 2, members: [
    open("rectMarquee", "marquee", "RectMarquee", "矩形选框", MarqueeIcon, "M", 2, "rectangle"),
    open("ellipseMarquee", "marquee", "EllipseMarquee", "椭圆选框", MarqueeIcon, "M", 3, "ellipse"),
    open("singleRowMarquee", "marquee", "SingleRowMarquee", "单行选框", MarqueeIcon, null, 4, "row"),
    open("singleColumnMarquee", "marquee", "SingleColumnMarquee", "单列选框", MarqueeIcon, null, 5, "column")
  ]},
  {index: 2, section: 2, members: [
    open("lasso", "lasso", "Lasso", "套索", LassoIcon, "L", 6),
    shut("polygonLasso", "lasso", "PolygonLasso", "多边形套索", LassoIcon, "L", 7, "多边形套索未实现（I078）"),
    shut("magneticLasso", "lasso", "MagneticLasso", "磁性套索", LassoIcon, "L", 8, "磁性套索未实现（I078）")
  ]},
  {index: 3, section: 2, members: [
    shut("objectSelection", "magicWand", "ObjectSelection", "对象选择", WandIcon, "W", 49, R_OBJECT_SELECTION),
    shut("quickSelection", "magicWand", "QuickSelection", "快速选择", WandIcon, "W", 48, R_QUICK_SELECTION),
    open("magicWand", "magicWand", "MagicWand", "魔棒", WandIcon, "W", 9)
  ]},
  {index: 4, section: 2, members: [
    shut("crop", "marquee", "Crop", "裁剪", MarqueeIcon, "C", 10, R_CROP),
    shut("perspectiveCrop", "marquee", "PerspectiveCrop", "透视裁切", MarqueeIcon, "C", 11, R_PERSPECTIVE_CROP),
    shut("slice", "marquee", "Slice", "切片", MarqueeIcon, "C", 64, R_SLICE),
    shut("sliceSelect", "marquee", "SliceSelect", "切片选择", MarqueeIcon, "C", 65, R_SLICE)
  ]},
  {index: 5, section: 2, members: [
    shut("frame", "marquee", "Frame", "Frame", MarqueeIcon, "K", 66, R_FRAME)
  ]},
  {index: 6, section: 2, members: [
    open("eyedropper", "eyedropper", "Eyedropper", "吸管", PipetteIcon, "I", 12),
    shut("colorSampler", "eyedropper", "ColorSampler", "颜色取样器", PipetteIcon, "I", 13, R_COLOR_SAMPLER),
    shut("ruler", "eyedropper", "Ruler", "量尺", PipetteIcon, "I", 14, R_RULER),
    shut("note", "eyedropper", "Note", "注释", PipetteIcon, "I", 15, R_NOTE),
    shut("count", "eyedropper", "Count", "计数", PipetteIcon, "I", 16, R_COUNT)
  ]},
  // 段 3
  {index: 7, section: 3, members: [
    shut("remove", "spotHealing", "Remove", "移除", BandageIcon, "J", 33, R_REMOVE),
    open("spotHealing", "spotHealing", "SpotHealing", "污点修复画笔", SyringeIcon, "J", 34),
    open("healingBrush", "healingBrush", "Healing", "修复画笔", BandageIcon, "J", 35),
    shut("patch", "spotHealing", "Patch", "修补", BandageIcon, "J", 36, R_PATCH),
    shut("contentAwareMove", "move", "ContentAwareMove", "内容感知移动", MoveIcon, "J", 37, R_CONTENT_AWARE_MOVE),
    open("redEye", "redEye", "RedEye", "红眼", ScanEyeIcon, "J", 38)
  ]},
  {index: 8, section: 3, members: [
    open("brush", "brush", "Brush", "画笔", BrushIcon, "B", 17),
    open("pencil", "pencil", "Pencil", "铅笔", PencilIcon, "B", 18),
    open("mixer", "mixer", "MixerBrush", "混合画笔", DropletsIcon, "B", 19),
    open("colorReplacement", "colorReplacement", "ColorReplacement", "颜色替换画笔", PaletteIcon, "B", 20)
  ]},
  {index: 9, section: 3, members: [
    open("cloneStamp", "cloneStamp", "CloneStamp", "仿制图章", StampIcon, "S", 39),
    open("patternStamp", "patternStamp", "PatternStamp", "图案图章", StampIcon, "S", 40)
  ]},
  {index: 10, section: 3, members: [
    open("historyBrush", "historyBrush", "HistoryBrush", "历史记录画笔", HistoryIcon, "Y", 41)
  ]},
  {index: 11, section: 3, members: [
    open("eraser", "eraser", "Eraser", "橡皮擦", EraserIcon, "E", 21),
    open("backgroundEraser", "backgroundEraser", "BackgroundEraser", "背景橡皮擦", EraserIcon, "E", 22),
    open("magicEraser", "magicEraser", "MagicEraser", "魔术橡皮擦", EraserIcon, "E", 23)
  ]},
  {index: 12, section: 3, members: [
    shut("gradient", "bucket", "Gradient", "渐变", PaintBucketIcon, "G", 24, R_GRADIENT),
    open("bucket", "bucket", "PaintBucket", "油漆桶", PaintBucketIcon, "G", 25)
  ]},
  {index: 13, section: 3, members: [
    open("blur", "blur", "Blur", "模糊", WavesIcon, null, 42),
    open("sharpen", "sharpen", "Sharpen", "锐化", SparklesIcon, null, 43),
    open("smudge", "smudge", "Smudge", "涂抹", WindIcon, null, 44)
  ]},
  {index: 14, section: 3, members: [
    open("dodge", "dodge", "Dodge", "减淡", SunMediumIcon, "O", 45),
    open("burn", "burn", "Burn", "加深", FlameIcon, "O", 46),
    open("sponge", "sponge", "Sponge", "海绵", DropletsIcon, "O", 47)
  ]},
  // 段 4
  {index: 15, section: 4, members: [
    shut("pen", "text", "Pen", "钢笔", PenIcon, "P", 50, R_PEN),
    shut("freeformPen", "text", "FreeformPen", "自由钢笔", PenIcon, "P", 51, R_PEN),
    shut("curvaturePen", "text", "CurvaturePen", "弯度钢笔", PenIcon, "P", 52, R_PEN),
    shut("addAnchorPoint", "text", "AddAnchorPoint", "添加锚点", PenIcon, "P", 53, R_PEN),
    shut("deleteAnchorPoint", "text", "DeleteAnchorPoint", "删除锚点", PenIcon, "P", 54, R_PEN),
    shut("convertPoint", "text", "ConvertPoint", "转换点", PenIcon, "P", 55, R_PEN)
  ]},
  {index: 16, section: 4, members: [
    open("horizontalType", "text", "Type", "横排文字", TypeIcon, "T", 26, "horizontal"),
    open("verticalType", "text", "VerticalType", "竖排文字", TypeIcon, "T", 27, "vertical"),
    // flyout 顺序照抄上游：VerticalTypeMask 在 HorizontalTypeMask 之前（循环序相反，见 cycleOrder）。
    shut("verticalTypeMask", "text", "VerticalTypeMask", "竖排文字蒙版", TypeIcon, "T", 29, R_TYPE_MASK),
    shut("horizontalTypeMask", "text", "HorizontalTypeMask", "横排文字蒙版", TypeIcon, "T", 28, R_TYPE_MASK)
  ]},
  {index: 17, section: 4, members: [
    shut("pathSelection", "text", "PathSelection", "路径选择", PenIcon, "A", 56, R_VECTOR),
    shut("directSelection", "text", "DirectSelection", "直接选择", PenIcon, "A", 57, R_VECTOR)
  ]},
  {index: 18, section: 4, members: [
    shut("rectangleShape", "marquee", "Rectangle", "矩形", MarqueeIcon, "U", 58, R_SHAPE),
    shut("ellipseShape", "marquee", "EllipseShape", "椭圆", MarqueeIcon, "U", 59, R_SHAPE),
    shut("triangleShape", "marquee", "Triangle", "三角形", MarqueeIcon, "U", 60, R_SHAPE),
    shut("polygonShape", "marquee", "Polygon", "多边形", MarqueeIcon, "U", 61, R_SHAPE),
    shut("lineShape", "marquee", "Line", "直线", MarqueeIcon, "U", 62, R_SHAPE),
    shut("customShape", "marquee", "CustomShape", "自定义形状", MarqueeIcon, "U", 63, R_SHAPE)
  ]},
  // 段 5
  {index: 19, section: 5, members: [
    open("pan", "pan", "Hand", "手形", MoveIcon, "H", 30),
    shut("rotateView", "pan", "RotateView", "旋转视图", MoveIcon, "R", 31, R_ROTATE_VIEW)
  ]},
  {index: 20, section: 5, members: [
    open("zoom", "zoom", "Zoom", "缩放", ZoomInIcon, "Z", 32)
  ]}
] as const;

/** 已开放成员：没有 `unsupported` 理由。 */
export function isAvailable(candidate: ToolMember): boolean {
  return candidate.unsupported === undefined;
}

/** 投影：丢掉未开放成员；槽空了丢掉槽；段空了丢掉段。 */
export function visibleToolSlots(slots: readonly ToolSlot[] = TOOL_SLOTS): readonly ToolSlot[] {
  return slots
    .map(slot => ({...slot, members: slot.members.filter(isAvailable)}))
    .filter(slot => slot.members.length > 0);
}

/** 按段分组后的可见槽位。 */
export function visibleToolSections(slots: readonly ToolSlot[] = TOOL_SLOTS): readonly {section: number; slots: readonly ToolSlot[]}[] {
  const sections = new Map<number, ToolSlot[]>();
  for (const slot of visibleToolSlots(slots)) {
    const list = sections.get(slot.section) ?? [];
    list.push(slot);
    sections.set(slot.section, list);
  }
  return [...sections].map(([section, list]) => ({section, slots: list}));
}

/** 工具栏里全部已开放成员，按槽位顺序。 */
export function toolbarMembers(): readonly ToolMember[] {
  return visibleToolSlots().flatMap(slot => slot.members);
}

/** 工具的显示名。变体工具按变体取，例如选框在 `row` 时显示「单行选框」。 */
export function toolLabelFor(tool: PhotoEditorTool, variant?: string): string {
  if (tool === "transform") return "自由变换";
  const slot = slotOf(tool);
  if (slot) return memberForVariant(slot, tool, variant)?.label ?? slot.members[0]!.label;
  // 未在工具栏出现的内部工具（例如 transform 之外的临时态）没有槽位；退回组标签。
  return TOOL_SLOTS.flatMap(entry => entry.members).find(member => member.tool === tool)?.label ?? tool;
}

/** 画布把手势交给该工具。工具栏成员都是画布工具；`transform` 由变换会话接管。 */
export function isCanvasTool(tool: PhotoEditorTool): tool is Exclude<PhotoEditorTool, "transform"> {
  return tool !== "transform";
}

/** 工具的槽位（用于高亮与记忆）；未开放工具返回 `undefined`。 */
export function slotOf(tool: PhotoEditorTool): ToolSlot | undefined {
  return visibleToolSlots().find(slot => slot.members.some(candidate => candidate.tool === tool));
}

/** 槽位里当前应显示的成员：同工具内命中变体则用它，否则槽内首成员。 */
export function memberForVariant(slot: ToolSlot, tool: PhotoEditorTool, variant?: string): ToolMember | undefined {
  const sameTool = slot.members.filter(candidate => candidate.tool === tool);
  if (!sameTool.length) return undefined;
  return sameTool.find(candidate => candidate.variant === variant) ?? sameTool[0];
}

/**
 * 字母分组。键为组字母，值为该组成员，**按循环序**（`cycleOrder`）排列 ——
 * 这是上游 `shortcuts.rs` 的 `group` 语义，与 flyout 顺序不同。
 * 成员粒度是槽位成员（含变体）：M 组同时含矩形与椭圆，T 组同时含横排与竖排。
 */
export function toolGroups(): ReadonlyMap<string, readonly ToolMember[]> {
  const groups = new Map<string, ToolMember[]>();
  for (const candidate of toolbarMembers()) {
    if (!candidate.key) continue;
    const list = groups.get(candidate.key) ?? [];
    list.push(candidate);
    groups.set(candidate.key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.cycleOrder - b.cycleOrder);
  return groups;
}

/**
 * 某个工具（含变体）对应的槽位成员 id。字母组按成员 id 比较，
 * 因此「矩形 → Shift+M → 椭圆」在同一组内前进，而不是原地不动。
 */
export function memberIdFor(tool: PhotoEditorTool, variant?: string): string | undefined {
  const slot = slotOf(tool);
  if (!slot) return undefined;
  const sameTool = slot.members.filter(candidate => candidate.tool === tool);
  return (sameTool.find(candidate => candidate.variant === variant) ?? sameTool[0])?.id;
}

/** 某工具所属的组成员（按组键）；无组键返回 `undefined`。 */
export function groupOf(tool: PhotoEditorTool): readonly ToolMember[] | undefined {
  return [...toolGroups().values()].find(list => list.some(candidate => candidate.tool === tool));
}
