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
  /** 打开本地文件（文件 ▸ 打开文件…）。 */
  onOpenFile?: () => void;
  /** 关闭当前文档（文件 ▸ 关闭）。 */
  onCloseDocument?: () => void;
  /** 文档清单（窗口菜单）；缺省不显示该项。 */
  list?: readonly { id: string; name: string; active: boolean; status?: string | null }[];
  onActivateDocument?: (id: string) => void;
};

/** 有文档菜单能力时才把「文件」放在最前面（与主流图像编辑器一致）。 */
export function editorMenusFor(documents?: EditorDocumentsMenu): readonly { label: string; items: readonly EditorMenuItem[] }[] {
  if (!documents) return EDITOR_MENUS;
  const items: EditorMenuItem[] = [];
  if (documents.onOpenFile) items.push({ id: "file.open", label: "打开文件…" });
  if (documents.onCloseDocument) items.push({ id: "file.close", label: "关闭", separatorBefore: items.length > 0 });
  return items.length ? [{ label: "文件", items }, ...EDITOR_MENUS] : EDITOR_MENUS;
}

export const EDITOR_MENUS: readonly { label: string; items: readonly EditorMenuItem[] }[] = [
  { label: "编辑", items: [
    command("edit.undo", "撤销"), command("edit.redo", "重做"),
    command("edit.cut", "剪切", true), command("edit.copy", "复制"), command("edit.copyMerged", "合并复制"),
    command("edit.paste", "粘贴"),
    group("pasteSpecial", "选择性粘贴", [command("edit.pasteSpecial.pasteInPlace", "原位粘贴")]),
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
    group("new", "新建", [command("layer.new.layer", "新建图层…"), command("layer.new.group", "组"), command("layer.new.layerViaCopy", "通过拷贝的图层", true)]),
    command("layer.duplicate", "复制图层"), command("layer.delete", "删除图层"),
    group("adjustment", "新建调整图层", ADJUSTMENT_LAYER_ACTIONS.map(({id, label}) => command(id, label)), true),
    group("layerMask", "图层蒙版", [
      command("layer.layerMask.revealAll", "显示全部"), command("layer.layerMask.hideAll", "隐藏全部"),
      command("layer.layerMask.revealSelection", "显示选区", true), command("layer.layerMask.hideSelection", "隐藏选区"),
      command("layer.layerMask.fromTransparency", "从透明区域", true),
      command("layer.layerMask.apply", "应用蒙版", true), command("layer.layerMask.delete", "删除蒙版")
    ], true),
    command("layer.createClippingMask", "创建剪贴蒙版"), command("layer.releaseClippingMask", "释放剪贴蒙版"),
    command("layer.groupLayers", "图层编组", true), command("layer.ungroupLayers", "取消图层编组"),
    group("arrange", "排列", [
      command("layer.arrange.bringToFront", "置为顶层"), command("layer.arrange.bringForward", "前移一层"),
      command("layer.arrange.sendBackward", "后移一层"), command("layer.arrange.sendToBack", "置为底层")
    ]),
    command("layer.mergeLayers", "合并图层", true), command("layer.mergeVisible", "合并可见图层"), command("layer.flattenImage", "拼合图像")
  ] },
  { label: "选择", items: [
    command("select.all", "全部"), command("select.deselect", "取消选择"), command("select.reselect", "重新选择"), command("select.inverse", "反向"),
    command("select.transformSelection", "变换选区", true)
  ] }
];
