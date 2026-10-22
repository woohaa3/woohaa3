//! 首期能力清单（React 与编辑内核共用，design D1/D3/D8）。
//!
//! 界面是我们自己的 React 组件，「隐藏入口」不再依赖上游菜单；关闭作用点是**唯一写入口**：
//! [`command_allowed`] 拒绝白名单外的命令，React 侧只渲染 `commandsJson()` 里 `allowed` 的命令。

/// 首期开放能力（与 `web/contracts/src/canvas/image-project-editor.ts` 的
/// `PHOTOCRAFT_CAPABILITIES` 一一对应）。
pub const CAPABILITIES: &[&str] = &[
    "layers.composite",
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
    "mask.pixel",
    "paint.brush",
    "paint.eraser",
    "text.horizontal",
    "adjust.brightness-contrast",
    "adjust.hue-saturation",
    "adjust.curves",
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
    "tool.magic-wand",
    "selection.ai-subject",
    "selection.hair-refine",
    "adjust.channel-curves",
    "adjust.lut",
    "color.icc",
    "color.cmyk",
    "color.hdr",
    "brush.external-abr",
    "type.path",
    "type.vertical",
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
    // 历史
    "edit.undo",
    "edit.redo",
    "edit.clear",
    "edit.copy",
    "edit.copyMerged",
    "edit.cut",
    "edit.paste",
    "edit.pasteSpecial.pasteInPlace",
    "edit.fillForeground",
    "edit.fillBackground",
    "edit.fillForegroundPreserve",
    "edit.fillBackgroundPreserve",
    // 文档
    "file.new",
    "file.close",
    // 图层
    "layer.new.layer",
    "layer.new.group",
    "layer.groupLayers",
    "layer.ungroupLayers",
    "layer.setExpanded",
    "layer.select",
    "layer.new.layerViaCopy",
    "layer.duplicate",
    "layer.delete",
    "layer.arrange.bringForward",
    "layer.arrange.sendBackward",
    "layer.arrange.bringToFront",
    "layer.arrange.sendToBack",
    "layer.mergeDown",
    "layer.mergeLayers",
    "layer.mergeVisible",
    "layer.flattenImage",
    "layer.renameLayer",
    "layer.setProps",
    "layer.lockLayers",
    "layer.moveTo",
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
    "layer.layerMask.linked",
    "channel.target.composite",
    "channel.target.layerMask",
    "view.layerMask",
    "layer.layerMask.fromTransparency",
    "layer.layerMask.hideAll",
    "layer.layerMask.revealAll",
    "layer.layerMask.revealSelection",
    "layer.layerMask.hideSelection",
    // 选区
    "select.all",
    "select.deselect",
    "select.inverse",
    "select.reselect",
    "select.transformSelection",
    "select.rect",
    "select.lasso",
    "select.modify.feather",
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
    // 绘画
    "paint.stroke",
    "tools.setBrush",
    "tools.setColors",
    "tools.increaseBrushSize",
    "tools.decreaseBrushSize",
    "tools.increaseBrushHardness",
    "tools.decreaseBrushHardness",
    // 文字
    "type.create",
    "type.edit",
    "type.setStyle",
    // 调色
    "image.adjustments.brightnessContrast",
    "image.adjustments.hueSaturation",
    "image.adjustments.curves",
    "layer.newAdjustmentLayer.brightnessContrast",
    "layer.newAdjustmentLayer.hueSaturation",
    "layer.newAdjustmentLayer.curves",
    "layer.setAdjustment",
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
    fn every_allowed_command_exists_in_the_engine_registry() {
        for id in ALLOWED_COMMANDS {
            assert!(
                photocraft_engine::commands::find(id).is_some(),
                "首期白名单里的命令 id 在上游注册表中不存在：{id}"
            );
        }
    }

    #[test]
    fn the_command_gate_closes_everything_outside_the_first_phase() {
        assert!(command_allowed("layer.delete"));
        assert!(command_allowed("select.modify.feather"));
        assert!(!command_allowed("file.placeEmbedded"));
        assert!(!command_allowed("file.automate.batch"));
        assert!(!command_allowed("plugin.run"));
        assert!(!command_allowed("filter.liquify"));
        assert!(!command_allowed("edit.preferences.general"));
        assert!(!command_allowed("select.subject"));
        assert!(!command_allowed("type.hitTest"));
    }
}
