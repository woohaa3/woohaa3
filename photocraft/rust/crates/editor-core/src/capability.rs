//! 首期能力清单（React 与编辑内核共用，design D1/D3/D8）。
//!
//! 界面是我们自己的 React 组件，「隐藏入口」不再依赖上游菜单；关闭作用点是**唯一写入口**：
//! [`command_allowed`] 拒绝白名单外的命令，React 侧只渲染 `commandsJson()` 里 `allowed` 的命令。

/// 首期开放能力（与 `web/contracts/src/canvas/image-project-editor.ts` 的
/// `PHOTOCRAFT_CAPABILITIES` 一一对应）。
pub const CAPABILITIES: &[&str] = &[
    "layers.composite",
  "layers.metadata",
    "layers.hover-preview",
  "mask.properties",
  "image.resolution",
    "layers.fill-opacity",
    "layers.styles.resource-free",
    "layers.styles.patterns",
    "layers.groups",
    "layers.blend.pass-through",
    "layers.blend.photoshop",
    "layers.blend.normal",
    "layers.blend.multiply",
    "layers.blend.screen",
    "compose.transform",
    "selection.rect",
    "selection.lasso",
    "selection.feather",
    "selection.wand",
    "selection.color-range",
    "selection.modify",
    "mask.pixel",
    "paint.brush",
    "paint.eraser",
    "paint.bucket",
    "paint.pencil",
    "paint.symmetry",
    "paint.retouch",
    "history.snapshots",
    "text.horizontal",
    "text.vertical",
    "text.refresh",
    "layers.rasterize",
    "text.defaults",
    "text.font-replacement",
    "adjust.brightness-contrast",
    "adjust.hue-saturation",
    "adjust.curves",
    "adjust.destructive",
    "layers.effects",
    "type.mask-selection",
    "image.color-mode",
];

/// 首期**明确关闭**的能力（PSD、智能对象、插件、高级工具等）。
pub const DISABLED_FEATURES: &[&str] = &[
    "format.psd-import",
    "format.psd-export",
    "format.psb",
    "layer.smart-object",
    "vector.path",
    "filter.complex",
    "filter.liquify",
    "tool.healing",
    "tool.clone",
    "selection.ai-subject",
    "selection.hair-refine",
    "adjust.channel-curves",
    "adjust.lut",
    "color.icc",
    "color.cmyk",
    "color.hdr",
    "brush.external-abr",
    "type.path",
    "print",
    "plugin",
    "automation.mcp",
    "batch.background",
    "file.open-external",
    "file.export-local",
];

/// 能力是否开放：未声明与显式关闭都返回 `false`。
pub fn is_enabled(id: &str) -> bool {
    !DISABLED_FEATURES.contains(&id) && CAPABILITIES.contains(&id)
}

/// 首期**唯一允许**执行的命令 id 集合（design D3/D8）。
///
/// React 只能分派这里的命令；菜单、工具栏、快捷键与命令面板都要先过 [`command_allowed`]。
/// 未接入的上游命令（PSD 导入导出、智能对象、矢量、复杂滤镜、修复、AI 选择、插件、自动化等）
/// 既不在本表，也在 [`DISABLED_FEATURES`] 里被显式声明关闭。
pub const ALLOWED_COMMANDS: &[&str] = &[
    "history.selectState",
    "history.newSnapshot",
    "history.selectSnapshot",
    "history.renameSnapshot",
    "history.deleteSnapshot",
    "history.deleteState",
    // 历史
    "edit.purge.undo",
    "edit.purge.clipboard",
    "edit.purge.histories",
    "edit.purge.all",
    "edit.purge.videoCache",
    "edit.undo",
    "edit.redo",
    "edit.toggleLastState",
    "edit.clear",
    "edit.definePattern",
    "edit.findAndReplaceText",
    "edit.checkSpelling",
    "edit.fill",
    "edit.stroke",
    "edit.fillHistory",
    "edit.fade",
    "edit.copy",
    "edit.copyMerged",
    "edit.cut",
    "edit.paste",
    "edit.pasteSpecial.pasteInPlace",
    "edit.pasteSpecial.pasteInto",
    "edit.pasteSpecial.pasteOutside",
    "edit.fillForeground",
    "edit.fillBackground",
    "edit.fillForegroundPreserve",
    "edit.fillBackgroundPreserve",
    "file.automate.fitImage",
    "file.automate.conditionalModeChange",
    "image.trim",
    "image.revealAll",
    "image.imageSize",
    "image.canvasSize",
    "image.rotation.arbitrary",
    // 文档
    "file.new",
    "document.presets.list",
    "document.presets.get",
    "document.presets.save",
    "document.presets.delete",
    "document.recent.list",
    "document.recent.add",
    "file.close",
    "file.fileInfo",
    // 图层
    "layer.new.layer",
    "layer.new.group",
    "layer.groupLayers",
    "layer.ungroupLayers",
    "layer.setExpanded",
    "layer.select",
    "layer.pickAt",
    "layer.selectInRect",
    "layer.setLabelColor",
    "layer.linkLayers",
    "layer.selectLinkedLayers",
    "layer.selectAbove",
    "layer.selectBelow",
    "layer.selectTop",
    "layer.selectBottom",
    "layer.addAboveToSelection",
    "layer.addBelowToSelection",
    "layer.showOnly",
    "layer.hideLayers",
    "layer.showLayers",
    "layer.new.layerFromBackground",
    "layer.new.layerViaCopy",
    "layer.new.layerViaCut",
    "layer.duplicate",
    "layer.delete",
    "layer.delete.hiddenLayers",
    "file.scripts.deleteAllEmptyLayers",
    "file.scripts.flattenAllMasks",
    "file.scripts.browse",
    "layer.arrange.bringForward",
    "layer.arrange.sendBackward",
    "layer.arrange.bringToFront",
    "layer.arrange.sendToBack",
    "layer.arrange.reverse",
    "layer.stampVisible",
    "layer.stampDown",
    "layer.new.backgroundFromLayer",
    "layer.matting.defringe",
    "layer.matting.colorDecontaminate",
    "layer.matting.removeBlackMatte",
    "layer.matting.removeWhiteMatte",
    "layer.mergeDown",
    "layer.mergeLayers",
    "layer.mergeVisible",
    "layer.flattenImage",
    "layer.renameLayer",
    "layer.setProps",
    "layer.lockLayers",
    "layer.moveTo",
    "layer.toggleClippingAt",
    "layer.createClippingMask",
    "layer.releaseClippingMask",
    "layer.align.topEdges",
    "layer.align.verticalCenters",
    "layer.align.bottomEdges",
    "layer.align.leftEdges",
    "layer.align.horizontalCenters",
    "layer.align.rightEdges",
    "layer.distribute.topEdges",
    "layer.distribute.verticalCenters",
    "layer.distribute.bottomEdges",
    "layer.distribute.leftEdges",
    "layer.distribute.horizontalCenters",
    "layer.distribute.rightEdges",
    "layer.distribute.horizontally",
    "layer.distribute.vertically",
    // 像素蒙版
    "layer.layerMask.apply",
    "layer.layerMask.delete",
    "layer.layerMask.enabled",
    "layer.layerMask.edit",
    "layer.layerMask.linked",
    "channel.target.composite",
    "channel.target.layerMask",
    "layer.toggleMaskOverlay",
    "view.layerMask",
    "layer.layerMask.fromTransparency",
    "layer.layerMask.hideAll",
    "layer.layerMask.revealAll",
    "layer.layerMask.revealSelection",
    "layer.layerMask.hideSelection",
    // 选区
    "view.newGuide",
    "view.moveGuide",
    "view.editGuide",
    "view.deleteGuide",
    "view.clearGuides",
    "view.setRulerOrigin",
    "view.resetRulerOrigin",
    "select.all",
    "select.deselectLayers",
    "select.deselect",
    "select.inverse",
    "select.reselect",
    "select.transformSelection",
    "select.allLayers",
    "select.findLayers",
    "select.isolateLayers",
    "select.rect",
    "select.lasso",
    "select.magicWand",
    "select.colorRange",
    "select.modify.feather",
    "select.modify.border",
    "select.modify.smooth",
    "select.modify.expand",
    "select.modify.contract",
    "select.grow",
    "select.similar",
    "select.editInQuickMaskMode",
    "select.saveSelection",
    "select.loadSelection",
    // 变换与画布
    "edit.transform",
    "edit.transform.rotate90Cw",
    "edit.transform.rotate90Ccw",
    "edit.transform.rotate180",
    "edit.transform.flipHorizontal",
    "edit.transform.flipVertical",
    "image.imageRotation.90cw",
    "image.imageRotation.90ccw",
    "image.imageRotation.180",
    "image.imageRotation.flipCanvasHorizontal",
    "image.imageRotation.flipCanvasVertical",
    "image.mode.rgb",
    "image.mode.grayscale",
    "image.mode.cmyk",
    "image.mode.lab",
    "image.mode.bits8",
    "image.mode.bits16",
    "image.mode.bits32",
    "image.mode.bitmap",
    "image.mode.duotone",
    "image.mode.multichannel",
    // 绘画
    "paint.stroke",
    "paint.pencil",
    "paint.setSymmetry",
    "paint.symmetryFromPath",
    "paint.symmetryDisable",
    "paint.bucket",
    "paint.colorReplacement",
    "paint.mixerBrush",
    "paint.patternStamp",
    "paint.historyBrush",
    "paint.cloneStamp",
    "paint.healingBrush",
    "cloneSource.list",
    "cloneSource.select",
    "cloneSource.set",
    "cloneSource.resetTransform",
    "cloneSource.overlay",
    "paint.dodge",
    "paint.burn",
    "paint.sponge",
    "paint.blur",
    "paint.sharpen",
    "paint.smudge",
    "paint.spotHealing",
    "paint.redEye",
    "paint.magicEraser",
    "paint.backgroundEraser",
    "brush.presets.list",
    "brush.presets.save",
    "brush.presets.update",
    "brush.presets.delete",
    "brush.presets.setCurrent",
    "brush.defineFromSelection",
    "brush.get",
    "tools.setBrush",
    "tools.setColors",
    "tools.increaseBrushSize",
    "tools.decreaseBrushSize",
    "tools.increaseBrushHardness",
    "tools.decreaseBrushHardness",
    // 文字
    "type.create",
    "type.createSelection",
    "type.orientation.horizontal",
    "type.orientation.vertical",
    "type.antiAlias.none",
    "type.antiAlias.sharp",
    "type.antiAlias.crisp",
    "type.antiAlias.strong",
    "type.antiAlias.smooth",
    "type.antiAlias.windowsLcd",
    "type.antiAlias.windows",
    "type.edit",
    "type.setStyle",
    "type.updateAllTextLayers",
    "layer.rasterize.type",
    "layer.rasterize.allLayers",
    "type.rasterizeTypeLayer",
    "type.saveDefaultTypeStyles",
    "type.loadDefaultTypeStyles",
    "type.resolveMissingFonts",
    "type.replaceAllMissingFonts",
    // 调色
    "image.adjustments.brightnessContrast",
    "image.adjustments.hueSaturation",
    "image.adjustments.curves",
    "layer.newAdjustmentLayer.brightnessContrast",
    "layer.newAdjustmentLayer.hueSaturation",
    "layer.newAdjustmentLayer.curves",
    "layer.setAdjustment",
    // 图层样式、填充层与批量效果
    "layer.layerStyle.createLayer",
    "layer.layerStyle.replace",
    "layer.layerStyle.copyLayerStyle",
    "layer.layerStyle.pasteLayerStyle",
    "layer.layerStyle.clear",
    "layer.layerStyle.hideAllEffects",
    "layer.layerStyle.showAllEffects",
    "layer.layerStyle.scaleEffects",
    "layer.rasterize.layerStyle",
    "file.scripts.flattenAllLayerEffects",
    // 图像调整与自动色调
    "image.adjustments.levels",
    "image.adjustments.exposure",
    "image.adjustments.vibrance",
    "image.adjustments.colorBalance",
    "image.adjustments.blackWhite",
    "image.adjustments.photoFilter",
    "image.adjustments.channelMixer",
    "image.adjustments.invert",
    "image.adjustments.posterize",
    "image.adjustments.threshold",
    "image.adjustments.gradientMap",
    "image.adjustments.selectiveColor",
    "image.adjustments.desaturate",
    "image.adjustments.equalize",
    "filter.lastFilter",
    "filter.blur.gaussianBlur",
    "filter.blur.blur",
    "filter.blur.blurMore",
    "filter.blur.boxBlur",
    "filter.blur.motionBlur",
    "filter.blur.surfaceBlur",
    "filter.sharpen.sharpen",
    "filter.sharpen.sharpenMore",
    "filter.sharpen.sharpenEdges",
    "filter.noise.despeckle",
    "filter.noise.median",
    "filter.noise.dustAndScratches",
    "filter.pixelate.mosaic",
    "filter.stylize.emboss",
    "filter.stylize.findEdges",
    "filter.stylize.solarize",
    "filter.distort.twirl",
    "filter.distort.pinch",
    "filter.distort.spherize",
    "filter.distort.ripple",
    "filter.distort.polarCoordinates",
    "filter.other.highPass",
    "filter.other.minimum",
    "filter.other.maximum",
    "image.autoTone",
    "image.autoContrast",
    "image.autoColor",
    // 非破坏式效果的其它入口
    "edit.transform.again",
    "edit.transform.againCopy",
];

/// 命令是否可以执行：只接受首期白名单内的 id。
pub fn command_allowed(id: &str) -> bool {
    ALLOWED_COMMANDS.contains(&id)
}

/// 过滤命令注册表快照，只保留首期允许的命令。
pub fn allowed_command_ids() -> Vec<&'static str> {
    ALLOWED_COMMANDS.to_vec()
}

/// 校验编辑器上报的一组能力；返回第一个未开放的能力 id。
pub fn first_disabled(ids: &[String]) -> Option<&str> {
    ids.iter().map(String::as_str).find(|id| !is_enabled(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_everything_outside_the_first_phase_list() {
        assert!(is_enabled("paint.brush"));
        assert!(is_enabled("adjust.curves"));
        assert!(!is_enabled("format.psd-import"));
        assert!(!is_enabled("tool.healing"));
        assert!(!is_enabled("plugin"));
        assert!(!is_enabled("unknown.feature"));
    }

    #[test]
    fn reports_the_first_unlisted_capability() {
        let ids = vec!["paint.brush".to_string(), "plugin".to_string()];
        assert_eq!(first_disabled(&ids), Some("plugin"));
        assert_eq!(first_disabled(&["text.horizontal".to_string()]), None);
    }

    #[test]
    fn every_allowed_command_has_an_upstream_or_owned_entry_and_write_route() {
        let mut editor=crate::editor::Editor::new();
        let entries=editor.commands();
        for id in ALLOWED_COMMANDS {
            assert!(entries.as_array().unwrap().iter().any(|entry|entry["id"]==*id && entry["allowed"]==true),"白名单命令缺少公开目录入口：{id}");
            if photocraft_engine::commands::find(id).is_none() {
                assert_eq!(*id,crate::clipping_commands::LINE_ID,"白名单命令缺少原生或自有路由：{id}");
                assert!(matches!(editor.execute(id,serde_json::json!({"upper":2,"lower":1})),Err(crate::error::EditorError::NoDocument)),"自有命令未到达写路由：{id}");
            }
        }
    }

    #[test]
    fn the_command_gate_closes_everything_outside_the_first_phase() {
        assert!(command_allowed("layer.delete"));
        assert!(command_allowed("select.modify.feather"));
        for id in ["select.magicWand","select.colorRange","select.modify.border","select.modify.smooth","select.modify.expand","select.modify.contract","select.grow","select.similar"] {
            assert!(command_allowed(id),"选区命令未开放：{id}");
        }
        for id in ["select.subject","select.sky","select.focusArea","layer.maskAllObjects","layer.removeBackground"] {
            assert!(!command_allowed(id),"主体/天空/焦点分割不属已承诺范围：{id}");
        }
        for id in ["paint.colorReplacement","paint.mixerBrush","paint.patternStamp","paint.historyBrush","paint.dodge","paint.burn","paint.sponge","paint.blur","paint.sharpen","paint.smudge","paint.spotHealing","paint.redEye","paint.magicEraser","paint.backgroundEraser"] {
            assert!(command_allowed(id),"润饰画笔未开放：{id}");
        }
        assert!(!command_allowed("file.placeEmbedded"));
        assert!(!command_allowed("file.automate.batch"));
        assert!(!command_allowed("plugin.run"));
        assert!(!command_allowed("filter.liquify"));
        assert!(!command_allowed("edit.preferences.general"));
        assert!(!command_allowed("select.subject"));
        assert!(!command_allowed("type.hitTest"));
    }

    #[test]
    fn clone_source_and_clone_brushes_stay_behind_the_command_gate() {
        // 克隆源面板由原生 `cloneSource.*` 提供；它们只改会话预设，不进入工程内容。
        for id in ["cloneSource.list","cloneSource.select","cloneSource.set","cloneSource.resetTransform","cloneSource.overlay","paint.cloneStamp","paint.healingBrush"] {
            assert!(command_allowed(id),"克隆工具或其来源面板未开放：{id}");
        }
        // 上游把 `tool.clone`/`tool.healing` 作为独立能力声明；本产品只开命令，不声明这两项 UI 能力。
        assert!(!is_enabled("tool.clone"));
        assert!(!is_enabled("tool.healing"));
    }
}
