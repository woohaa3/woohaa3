/** 仅编排已接入的菜单能力；路径参照固定版本 PhotoCraft 的 Photoshop 菜单目录。 */
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";

type CommandItem = { id: string; label: string; separatorBefore?: boolean };
export type EditorMenuItem = CommandItem & { children?: readonly EditorMenuItem[] };
const command = (id: string, label: string, separatorBefore = false): EditorMenuItem => ({ id, label, separatorBefore });
const group = (id: string, label: string, children: readonly EditorMenuItem[], separatorBefore = false): EditorMenuItem => ({ id, label, children, separatorBefore });

/**
 * 宿主提供的文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
 *
 * 打开文件、关闭文档与文档清单属于**菜单**，不挂在文档标签条上（标签条只放标签，和
 * Photoshop 一致）。核心包只声明形状，实际动作与清单由宿主注入。
 */
export type EditorDocumentsMenu = {
  /** 工作区持有剪贴板，跨文档与视图卸载后仍保留。 */
  transfer?: { enabled: boolean; onSelect: (id: string) => void };
  /** 打开本地文件（文件 ▸ 打开文件…）。 */
  onOpenFile?: () => void;
  /**
   * 新建空白文档（文件 ▸ 新建…，change: 2026-10-22-add-photocraft-file-workflows，U01）。
   *
   * 一个编辑会话只有一个文档槽位，所以「已有文档时再新建」必须由宿主另开一个文档/标签。
   */
  onNewDocument?: () => void;
  /** 关闭当前文档（文件 ▸ 关闭）。 */
  onCloseDocument?: () => void;
  /**
   * 关闭其他文档（文件 ▸ 关闭其他，U03）。
   *
   * 逐文档串行结算，首个失败即停止并保留其余文档；不保存、不丢弃未确认草稿。
   */
  onCloseOthers?: () => void;
  /** 关闭全部文档（文件 ▸ 关闭全部，U03）；同样是串行结算。 */
  onCloseAll?: () => void;
  /** 置入图片到当前文档（文件 ▸ 置入图片…）。 */
  onPlaceImage?: () => void;
  /** 导入 PSD（文件 ▸ 导入 PSD…）。 */
  onOpenPsd?: () => void;
  /** 导出 PSD（文件 ▸ 导出 PSD…）。 */
  onExportPsd?: () => void;
  /** 活动文档的保存动作与可见名称。 */
  onSave?: () => void;
  saveLabel?: string;
  /** 导出当前合成 PNG，不改变工程保存状态。 */
  onExportPng?: () => void;
  /**
   * 打开「导出为…」（change: 2026-10-22-add-photocraft-raster-interchange）。
   *
   * 与 `onExportPng` 的区别：PNG 是固定格式的快捷导出，这里进入本域的通用导出面板
   * （逐格式 + 参数 + 真实预览），不写盘、不改保存基线。
   */
  onExportRaster?: () => void;
  /** 打开「Save for Web…」（同一面板的 web 模式）。 */
  onExportWeb?: () => void;
  /** 文档清单（窗口菜单）；缺省不显示该项。 */
  list?: readonly { id: string; name: string; active: boolean; status?: string | null }[];
  onActivateDocument?: (id: string) => void;
};

/** 有文档菜单能力时才把「文件」放在最前面（与主流图像编辑器一致）。 */
export function editorMenusFor(documents?: EditorDocumentsMenu): readonly { label: string; items: readonly EditorMenuItem[] }[] {
  const extra: EditorMenuItem[] = [
    command("edit.layerTransferCopy", "复制到工作区剪贴板"),
    command("edit.layerTransferPaste", "从工作区剪贴板粘贴"),
    command("edit.layerTransferPasteInPlace", "原位粘贴（跨文档）")
  ];
  const items: EditorMenuItem[] = [];
  if (documents?.onNewDocument) items.push({ id: "file.new", label: "新建…" });
  if (documents?.onOpenFile) items.push({ id: "file.open", label: "打开文件…" });
  if (documents?.saveLabel) items.push({ id: "file.save", label: documents.saveLabel, separatorBefore: items.length > 0 });
  if (documents?.onPlaceImage) items.push({ id: "file.place", label: "置入图片…", separatorBefore: items.length > 0 });
  if (documents?.onOpenPsd) items.push({ id: "file.openPsd", label: "导入 PSD…", separatorBefore: items.length > 0 });
  if (documents?.onExportPsd) items.push({ id: "file.exportPsd", label: "导出 PSD…" });
  if (documents?.onExportPng) items.push({ id: "file.exportPng", label: "导出 PNG…" });
  // 通用导出与 Save for Web 都是本域面板的入口（change: 2026-10-22-add-photocraft-raster-interchange）。
  if (documents?.onExportRaster) items.push({ id: "file.exportRaster", label: "导出为…", separatorBefore: true });
  if (documents?.onExportWeb) items.push({ id: "file.exportWeb", label: "Save for Web…" });
  if (documents?.onCloseDocument) items.push({ id: "file.close", label: "关闭", separatorBefore: items.length > 0 });
  // 批量关闭是**工作区**操作：逐文档串行结算，不是内核命令（上游只有 `file.close` 单文档）。
  if (documents?.onCloseOthers) items.push({ id: "file.closeOthers", label: "关闭其他" });
  if (documents?.onCloseAll) items.push({ id: "file.closeAll", label: "关闭全部" });
  const base = EDITOR_MENUS.map((menu) =>
    menu.label === "编辑"
      ? { ...menu, items: [...menu.items, ...extra.map((entry, index) => ({ ...entry, separatorBefore: index === 0 }))] }
      : menu
  );
  return items.length ? [{ label: "文件", items }, ...base] : base;
}

export const EDITOR_MENUS: readonly { label: string; items: readonly EditorMenuItem[] }[] = [
  { label: "编辑", items: [
    command("edit.undo", "撤销"), command("edit.redo", "重做"),
    command("edit.cut", "剪切", true), command("edit.copy", "复制"), command("edit.copyMerged", "合并复制"),
    command("edit.paste", "粘贴"),
    group("pasteSpecial", "选择性粘贴", [
      command("edit.pasteSpecial.pasteInPlace", "原位粘贴"),
      command("edit.pasteSpecial.pasteInto", "粘贴入…", true), command("edit.pasteSpecial.pasteOutside", "粘贴外…")
    ]),
    command("edit.clear", "清除"),
    group("fill", "填充", [
      command("edit.fillForeground", "前景色"), command("edit.fillBackground", "背景色"),
      command("edit.fillForegroundPreserve", "前景色并保留透明度", true), command("edit.fillBackgroundPreserve", "背景色并保留透明度")
    ], true),
    command("edit.transform", "自由变换", true),
    group("transform", "变换", [
      command("edit.transform.rotate180", "旋转 180°"),
      command("edit.transform.rotate90Cw", "顺时针旋转 90°"), command("edit.transform.rotate90Ccw", "逆时针旋转 90°"),
      command("edit.transform.flipHorizontal", "水平翻转", true), command("edit.transform.flipVertical", "垂直翻转")
    ])
  ] },
  { label: "图像", items: [group("imageRotation", "图像旋转", [
    command("image.imageRotation.180", "旋转图像 180°"),
    command("image.imageRotation.90cw", "顺时针旋转图像 90°"), command("image.imageRotation.90ccw", "逆时针旋转图像 90°"),
    command("image.imageRotation.flipCanvasHorizontal", "水平翻转画布", true), command("image.imageRotation.flipCanvasVertical", "垂直翻转画布")
  ])] },
  { label: "图层", items: [
    group("new", "新建", [
      command("layer.new.layer", "新建图层…"), command("layer.new.group", "组"),
      command("layer.new.layerViaCopy", "通过拷贝的图层", true), command("layer.new.layerViaCut", "通过剪切的图层"),
      command("layer.new.layerFromBackground", "背景图层…", true), command("layer.new.backgroundFromLayer", "图层背景")
    ]),
    command("layer.duplicate", "复制图层"), command("layer.delete", "删除图层"),
    command("layer.linkLayers", "链接/取消链接图层", true), command("layer.selectLinkedLayers", "选择链接图层"),
    group("adjustment", "新建调整图层", ADJUSTMENT_LAYER_ACTIONS.map(({id, label}) => command(id, label)), true),
    group("layerMask", "图层蒙版", [
      command("layer.layerMask.revealAll", "显示全部"), command("layer.layerMask.hideAll", "隐藏全部"),
      command("layer.layerMask.revealSelection", "显示选区", true), command("layer.layerMask.hideSelection", "隐藏选区"),
      command("layer.layerMask.fromTransparency", "从透明区域", true),
      command("layer.layerMask.apply", "应用蒙版", true), command("layer.layerMask.delete", "删除蒙版")
    ], true),
    command("layer.createClippingMask", "创建剪贴蒙版"), command("layer.releaseClippingMask", "释放剪贴蒙版"),
    command("layer.groupLayers", "图层编组", true), command("layer.ungroupLayers", "取消图层编组"),
    group("layerStyle", "图层样式", [
      command("layer.layerStyle.blendingOptions", "混合选项…"),
      command("layer.layerStyle.copyLayerStyle", "拷贝图层样式", true), command("layer.layerStyle.pasteLayerStyle", "粘贴图层样式"),
      command("layer.layerStyle.clear", "清除图层样式"), command("layer.layerStyle.createLayer", "效果转层", true),
      command("layer.layerStyle.scaleEffects", "缩放效果…")
    ], true),
    group("matting", "去边与净化", [
      command("layer.matting.defringe", "去边…"), command("layer.matting.removeBlackMatte", "移除黑色杂边"),
      command("layer.matting.removeWhiteMatte", "移除白色杂边"),
      command("layer.matting.colorDecontaminate", "颜色净化…", true)
    ], true),
    group("arrange", "排列", [
      command("layer.arrange.bringToFront", "置为顶层"), command("layer.arrange.bringForward", "前移一层"),
      command("layer.arrange.sendBackward", "后移一层"), command("layer.arrange.sendToBack", "置为底层"),
      command("layer.arrange.reverse", "反转顺序", true)
    ]),
    group("stamp", "盖印", [
      command("layer.stampVisible", "盖印可见图层"), command("layer.stampDown", "向下盖印")
    ], true),
    command("layer.mergeLayers", "合并图层", true), command("layer.mergeVisible", "合并可见图层"), command("layer.flattenImage", "拼合图像"),
    group("rasterize", "栅格化", [command("layer.rasterize.layerStyle", "图层样式")], true)
  ] },
  { label: "选择", items: [
    command("select.all", "全部"), command("select.deselect", "取消选择"), command("select.reselect", "重新选择"), command("select.inverse", "反向"),
    command("select.transformSelection", "变换选区", true)
  ] },
  { label: "滤镜", items: [command("filter.lastFilter", "重复上次滤镜")] }
];
