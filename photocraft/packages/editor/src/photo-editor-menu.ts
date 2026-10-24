import {TEXT_ANTIALIAS} from "./text-antialias.js";
/** 仅编排已接入的菜单能力；路径参照固定版本 PhotoCraft 的 Photoshop 菜单目录。 */
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
import { FILTER_GROUPS, FILTER_SPECS } from "./filter-catalog.js";

type CommandItem = { id: string; label: string; separatorBefore?: boolean };
export type EditorMenuItem = CommandItem & { children?: readonly EditorMenuItem[] };
const command = (id: string, label: string, separatorBefore = false): EditorMenuItem => ({ id, label, separatorBefore });
const group = (id: string, label: string, children: readonly EditorMenuItem[], separatorBefore = false): EditorMenuItem => ({ id, label, children, separatorBefore });
// 滤镜分组允许空子菜单被过滤掉，因此单独取一个变量名避免与上面的 `group` 混淆。
const group2 = group;

/**
 * 宿主提供的文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
 *
 * 打开文件、关闭文档与文档清单属于**菜单**，不挂在文档标签条上（标签条只放标签，和
 * Photoshop 一致）。核心包只声明形状，实际动作与清单由宿主注入。
 */
export type WorkspacePurgeId="edit.purge.clipboard"|"edit.purge.histories"|"edit.purge.all";
export type WorkspacePurgePort={commands:Record<WorkspacePurgeId,{enabled:boolean;reason?:string}>;execute:(id:WorkspacePurgeId)=>{ok:boolean;message?:string}};
export type EditorDocumentsMenu = {
  onDuplicateDocument?:()=>void;
  duplicateDisabled?:boolean;
  purge?:WorkspacePurgePort;
  /** 打开本地文件（文件 ▸ 打开文件…）。 */
  onOpenFile?: () => void;
  /** 关闭当前文档（文件 ▸ 关闭）。 */
  onCloseDocument?: () => void;
  onCloseAllDocuments?:()=>void;
  onCloseOtherDocuments?:()=>void;
  /** 文档清单（窗口菜单）；缺省不显示该项。 */
  list?: readonly { id: string; name: string; active: boolean; status?: string | null }[];
  onActivateDocument?: (id: string) => void;
  /** 「文件 ▸ 新建…」由编辑器自己的表单分派 `file.new`；缺省不显示该项。 */
  onNewDocument?: () => void;
  /** 「文件 ▸ 导出…」由编辑器自己的表单编码并交付；缺省不显示该项。 */
  onExport?: () => void;
};

/** 有文档菜单能力时才把「文件」放在最前面（与主流图像编辑器一致）。 */
export function editorMenusFor(documents?: EditorDocumentsMenu): readonly { label: string; items: readonly EditorMenuItem[] }[] {
  if (!documents) return EDITOR_MENUS;
  const items: EditorMenuItem[] = [];
  if (documents.onNewDocument) items.push({ id: "file.new", label: "新建…" });
  if (documents.onOpenFile) items.push({ id: "file.open", label: "打开文件…" });
  if (documents.onExport) items.push({ id: "file.exportAs", label: "导出…" });
  if (documents.onOpenFile || documents.onCloseDocument) items.push({ id: "file.fileInfo", label: "文件信息…" });
  if (documents.onCloseDocument) items.push({ id: "file.close", label: "关闭", separatorBefore: items.length > 0 });
  if(documents.onCloseAllDocuments)items.push({id:"file.closeAll",label:"关闭全部"});
  if(documents.onCloseOtherDocuments)items.push({id:"file.closeOthers",label:"关闭其他文档"});
  return EDITOR_MENUS.map(menu=>menu.label==="文件" ? {...menu,items:[...items,...menu.items.map((item,index)=>index===0?{...item,separatorBefore:true}:item)]}:menu.label==="图像" && documents.onDuplicateDocument?{...menu,items:[{id:"image.duplicateDocument",label:"复制文档"},...menu.items]}:menu);
}

export const EDITOR_MENUS: readonly { label: string; items: readonly EditorMenuItem[] }[] = [
  {label:"文件",items:[group("automate","自动",[command("file.automate.fitImage","适合图像…"),command("file.automate.conditionalModeChange","条件模式转换…")]),group("scripts","脚本",[command("file.scripts.deleteAllEmptyLayers","删除全部空图层"),command("file.scripts.flattenAllMasks","扁平化全部蒙版"),command("file.scripts.flattenAllLayerEffects","扁平化全部图层效果"),command("file.scripts.browse","浏览脚本…")])]},
  { label: "编辑", items: [
    command("edit.undo", "撤销"), command("edit.redo", "重做"), command("edit.toggleLastState", "切换上一次状态"),
    command("edit.cut", "剪切", true), command("edit.copy", "复制"), command("edit.copyMerged", "合并复制"),
    command("edit.paste", "粘贴"),
    group("pasteSpecial", "选择性粘贴", [command("edit.pasteSpecial.pasteInPlace", "原位粘贴"),command("edit.pasteSpecial.pasteInto","粘贴入"),command("edit.pasteSpecial.pasteOutside","粘贴外部")]),
    command("edit.clear", "清除"),
    command("edit.fade", "淡化…"),
    command("edit.stroke", "描边…"),
    command("edit.fill", "填充…"),
    command("edit.definePattern", "定义图案…"),
    command("edit.checkSpelling", "检查拼写…"),
    command("edit.findAndReplaceText", "查找和替换文字…"),
    group("purge","清理",[command("edit.purge.undo","最近撤销状态"),command("edit.purge.clipboard","应用剪贴板"),command("edit.purge.histories","全部操作历史"),command("edit.purge.videoCache","视频缓存"),command("edit.purge.all","全部",true)]),
    group("fill", "填充", [
      command("edit.fillForeground", "前景色"), command("edit.fillBackground", "背景色"),
      command("edit.fillForegroundPreserve", "前景色并保留透明度", true), command("edit.fillBackgroundPreserve", "背景色并保留透明度"),command("edit.fillHistory","从历史记录填充",true)
    ], true),
    command("edit.transform", "自由变换", true),
    command("edit.transform.again", "再次变换"),
    command("edit.transform.againCopy", "再次变换并复制"),
    group("transform", "变换", [
      command("edit.transform.rotate180", "旋转 180°"),
      command("edit.transform.rotate90Cw", "顺时针旋转 90°"), command("edit.transform.rotate90Ccw", "逆时针旋转 90°"),
      command("edit.transform.flipHorizontal", "水平翻转", true), command("edit.transform.flipVertical", "垂直翻转")
    ])
  ] },
  { label: "图像", items: [command("image.imageSize","图像大小…"),command("image.canvasSize","画布大小…"),command("image.trim","修整…"),command("image.revealAll","显示全部"),
    group("adjustments","调整",[command("image.autoTone","自动色调"),command("image.autoContrast","自动对比度"),command("image.autoColor","自动颜色"),command("image.adjustments.levels","色阶…"),command("image.adjustments.exposure","曝光度…"),command("image.adjustments.vibrance","自然饱和度…"),command("image.adjustments.colorBalance","色彩平衡…"),command("image.adjustments.blackWhite","黑白…"),command("image.adjustments.photoFilter","照片滤镜…"),command("image.adjustments.channelMixer","通道混合器…"),command("image.adjustments.invert","反相"),command("image.adjustments.posterize","色调分离…"),command("image.adjustments.threshold","阈值…"),command("image.adjustments.gradientMap","渐变映射…"),command("image.adjustments.selectiveColor","可选颜色…"),command("image.adjustments.desaturate","去色"),command("image.adjustments.equalize","色调均化")]),
    command("image.colorMode","图像模式与位深…",true),
    group("imageRotation", "图像旋转", [
    command("image.rotation.arbitrary", "任意角度…"),
    command("image.imageRotation.180", "旋转图像 180°"),
    command("image.imageRotation.90cw", "顺时针旋转图像 90°"), command("image.imageRotation.90ccw", "逆时针旋转图像 90°"),
    command("image.imageRotation.flipCanvasHorizontal", "水平翻转画布", true), command("image.imageRotation.flipCanvasVertical", "垂直翻转画布")
  ])] },
  { label: "图层", items: [
    group("new", "新建", [command("layer.new.layer", "新建图层…"), command("layer.new.group", "组"),command("layer.new.layerFromBackground","从背景创建图层"),command("layer.new.backgroundFromLayer","从图层创建背景"), command("layer.new.layerViaCopy", "通过拷贝的图层", true), command("layer.new.layerViaCut", "通过剪切的图层")]),
    group("rasterize","栅格化",[command("layer.rasterize.type","文字"),command("layer.rasterize.allLayers","全部图层"),command("layer.rasterize.layerStyle","图层样式")]),
    group("layerStyleMenu","图层样式",[command("layer.layerStyle.createLayer","创建图层"),command("layer.layerStyle.scaleEffects","缩放效果…")]),
    command("layer.linkLayers", "链接 / 取消链接图层"), command("layer.selectLinkedLayers", "选择链接图层"),
    command("layer.lockLayers", "锁定图层…"),
    command("layer.duplicate", "复制图层"), command("layer.delete", "删除图层"), command("layer.delete.hiddenLayers", "删除隐藏图层"),
    command("layer.hideLayers", "隐藏 / 显示所选图层"),
    group("adjustment", "新建调整图层", ADJUSTMENT_LAYER_ACTIONS.map(({id, label}) => command(id, label)), true),
    group("layerMask", "图层蒙版", [
      command("layer.layerMask.revealAll", "显示全部"), command("layer.layerMask.hideAll", "隐藏全部"),
      command("layer.layerMask.revealSelection", "显示选区", true), command("layer.layerMask.hideSelection", "隐藏选区"),
      command("layer.layerMask.fromTransparency", "从透明区域", true),
      command("layer.layerMask.apply", "应用蒙版", true), command("layer.layerMask.delete", "删除蒙版"),
      command("layer.toggleMaskOverlay", "显示蒙版叠加（红色）", true)
    ], true),
    command("layer.createClippingMask", "创建剪贴蒙版"), command("layer.releaseClippingMask", "释放剪贴蒙版"),
    command("layer.groupLayers", "图层编组", true), command("layer.ungroupLayers", "取消图层编组"),
    group("arrange", "排列", [
      command("layer.arrange.bringToFront", "置为顶层"), command("layer.arrange.bringForward", "前移一层"),
      command("layer.arrange.sendBackward", "后移一层"), command("layer.arrange.sendToBack", "置为底层"), command("layer.arrange.reverse", "反转所选图层顺序")
    ]),
    group("matting","去边",[command("layer.matting.defringe","去边…"),command("layer.matting.colorDecontaminate","颜色净化…"),command("layer.matting.removeBlackMatte","移去黑色杂边"),command("layer.matting.removeWhiteMatte","移去白色杂边")]),
    group("layerStyleAll","图层样式",[
      command("layer.layerStyle.copyLayerStyle","拷贝图层样式"),command("layer.layerStyle.pasteLayerStyle","粘贴图层样式"),command("layer.layerStyle.clear","清除图层样式"),
      command("layer.layerStyle.hideAllEffects","隐藏全部图层效果",true),command("layer.layerStyle.showAllEffects","显示全部图层效果")
    ]),
    command("layer.stampDown","盖印图层"),command("layer.stampVisible","盖印可见图层"),
    command("layer.mergeLayers", "合并图层", true), command("layer.mergeVisible", "合并可见图层"), command("layer.flattenImage", "拼合图像")
  ] },
  {label:"文字",items:[group("typeOrientation","方向",[command("type.orientation.horizontal","横排"),command("type.orientation.vertical","竖排")]),group("typeAntiAlias","抗锯齿",TEXT_ANTIALIAS.map(mode=>command(`type.antiAlias.${mode.id}`,mode.label))),command("type.rasterizeTypeLayer","栅格化文字图层"),command("type.updateAllTextLayers","刷新全部文字图层"),command("type.createSelection","文字蒙版转选区…"),command("type.saveDefaultTypeStyles","保存默认文字样式",true),command("type.loadDefaultTypeStyles","载入默认文字样式"),command("type.resolveMissingFonts","替换缺失字体…",true),command("type.replaceAllMissingFonts","全部缺失字体替换为 Inter")]},
  // Filter 菜单：只列固定引擎已实现、参数契约明确的滤镜（I035）。
  { label: "滤镜", items: [
    ...FILTER_GROUPS.map(group => group2(`filter.${group}`, group, FILTER_SPECS.filter(spec => spec.group === group).map(spec => command(spec.id, spec.label)))),
    command("filter.lastFilter", "重复上一次滤镜", true)
  ].filter(item => item.children?.length || item.id === "filter.lastFilter") },
  { label: "选择", items: [
    command("select.all", "全部"), command("select.deselect", "取消选择"), command("select.reselect", "重新选择"), command("select.inverse", "反向"),
    command("select.colorRange", "颜色范围…", true),
    group("modify","修改",[command("select.modify.border","边框…"),command("select.modify.smooth","平滑…"),command("select.modify.expand","扩展…"),command("select.modify.contract","收缩…"),command("select.modify.feather","羽化…")]),
    command("select.grow","扩展相似像素"),command("select.similar","选择相似颜色"),
    command("select.saveSelection","存储选区…",true),command("select.loadSelection","载入选区…"),
    command("select.editInQuickMaskMode","以快速蒙版模式编辑",true),
    command("select.transformSelection", "变换选区", true),
    command("select.allLayers", "所有非背景图层", true), command("select.deselectLayers", "取消图层选择"), command("select.findLayers", "查找图层…"), command("select.isolateLayers", "隔离 / 恢复图层列表")
  ] }
];
