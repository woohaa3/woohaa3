use super::{FeatureContribution, StagedId};

/// 构图域的能力与命令贡献（U50–U56：裁剪、尺寸、裁边/旋转、变换变形、填充、照片、画板切片）。
///
/// `order` 只在**同阶段内**决定排序，但同一阶段由 18 个域共同贡献，因此本域占用两段专属区间
/// （能力 40–64、命令 100–134），避免与其他域的 P7 编号交错后出现相对顺序歧义。
///
/// 能力 id 用 kebab-case、命令 id 沿用上游 camelCase 是既有约定：能力是「界面可宣称支持什么」，
/// 命令是「内核能执行什么」，两者不是一一对应的字符串。
pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "composition",
    capabilities: &[
        StagedId { stage: "P0", order: 10, id: "compose.transform" },
        StagedId { stage: "P7", order: 0, id: "image.crop" },
        StagedId { stage: "P7", order: 1, id: "image.image-size" },
        StagedId { stage: "P7", order: 2, id: "image.canvas-size" },
        StagedId { stage: "P7", order: 11, id: "image.perspective-crop" },
        StagedId { stage: "P7", order: 12, id: "image.trim" },
        StagedId { stage: "P7", order: 13, id: "image.reveal-all" },
        StagedId { stage: "P7", order: 14, id: "image.rotation.arbitrary" },
        StagedId { stage: "P7", order: 15, id: "transform.again" },
        StagedId { stage: "P7", order: 16, id: "transform.warp" },
        StagedId { stage: "P7", order: 17, id: "transform.warp-grid" },
        StagedId { stage: "P7", order: 18, id: "transform.perspective-warp" },
        StagedId { stage: "P7", order: 19, id: "transform.puppet-warp" },
        StagedId { stage: "P7", order: 20, id: "fill.arbitrary" },
        StagedId { stage: "P7", order: 21, id: "fill.content-aware" },
        StagedId { stage: "P7", order: 22, id: "fill.content-aware-scale" },
        StagedId { stage: "P7", order: 23, id: "fill.stroke" },
        StagedId { stage: "P7", order: 24, id: "edit.fade" },
        StagedId { stage: "P7", order: 25, id: "photo.auto-align" },
        StagedId { stage: "P7", order: 26, id: "photo.auto-blend" },
        StagedId { stage: "P7", order: 27, id: "photo.photomerge" },
        StagedId { stage: "P7", order: 28, id: "photo.merge-hdr" },
        StagedId { stage: "P7", order: 29, id: "photo.crop-and-straighten" },
        StagedId { stage: "P7", order: 30, id: "structure.artboard" },
        StagedId { stage: "P7", order: 31, id: "structure.frame" },
        StagedId { stage: "P7", order: 32, id: "structure.slice" },
    ],
    commands: &[
        StagedId { stage: "P0", order: 73, id: "edit.transform" },
        StagedId { stage: "P0", order: 74, id: "edit.transform.rotate90Cw" },
        StagedId { stage: "P0", order: 75, id: "edit.transform.rotate90Ccw" },
        StagedId { stage: "P0", order: 76, id: "edit.transform.rotate180" },
        StagedId { stage: "P0", order: 77, id: "edit.transform.flipHorizontal" },
        StagedId { stage: "P0", order: 78, id: "edit.transform.flipVertical" },
        StagedId { stage: "P0", order: 79, id: "image.imageRotation.90cw" },
        StagedId { stage: "P0", order: 80, id: "image.imageRotation.90ccw" },
        StagedId { stage: "P0", order: 81, id: "image.imageRotation.180" },
        StagedId { stage: "P0", order: 82, id: "image.imageRotation.flipCanvasHorizontal" },
        StagedId { stage: "P0", order: 83, id: "image.imageRotation.flipCanvasVertical" },
        StagedId { stage: "P0", order: 94, id: "image.adjustments.brightnessContrast" },
        StagedId { stage: "P0", order: 95, id: "image.adjustments.hueSaturation" },
        StagedId { stage: "P0", order: 96, id: "image.adjustments.curves" },
        StagedId { stage: "P5", order: 0, id: "image.adjustments.levels" },
        StagedId { stage: "P5", order: 1, id: "image.adjustments.curves" },
        StagedId { stage: "P5", order: 2, id: "image.adjustments.vibrance" },
        StagedId { stage: "P5", order: 3, id: "image.adjustments.blackWhite" },
        // ---- U50 裁剪（显示全部复用 image.crop，故不单独占命令）
        StagedId { stage: "P7", order: 100, id: "image.crop" },
        StagedId { stage: "P7", order: 101, id: "image.perspectiveCrop" },
        // ---- U51 尺寸
        StagedId { stage: "P7", order: 102, id: "image.imageSize" },
        StagedId { stage: "P7", order: 103, id: "image.canvasSize" },
        // ---- U52 裁边与整图旋转
        StagedId { stage: "P7", order: 104, id: "image.trim" },
        StagedId { stage: "P7", order: 105, id: "image.rotation.arbitrary" },
        // ---- U53 再次变换与变形族
        StagedId { stage: "P7", order: 106, id: "edit.transform.again" },
        StagedId { stage: "P7", order: 107, id: "edit.transform.againCopy" },
        StagedId { stage: "P7", order: 108, id: "edit.transform.warp" },
        StagedId { stage: "P7", order: 109, id: "edit.transform.warpGrid" },
        StagedId { stage: "P7", order: 110, id: "edit.transform.splitWarpCrosswise" },
        StagedId { stage: "P7", order: 111, id: "edit.transform.splitWarpHorizontally" },
        StagedId { stage: "P7", order: 112, id: "edit.transform.splitWarpVertically" },
        StagedId { stage: "P7", order: 113, id: "edit.transform.removeWarpSplit" },
        StagedId { stage: "P7", order: 114, id: "edit.perspectiveWarp" },
        StagedId { stage: "P7", order: 115, id: "edit.puppetWarp" },
        // ---- U54 填充族与渐隐
        StagedId { stage: "P7", order: 116, id: "edit.fill" },
        StagedId { stage: "P7", order: 117, id: "edit.contentAwareFill" },
        StagedId { stage: "P7", order: 118, id: "edit.contentAwareScale" },
        StagedId { stage: "P7", order: 119, id: "edit.stroke" },
        StagedId { stage: "P7", order: 120, id: "edit.fade" },
        // ---- U55 按内容对齐/混合与照片合并
        StagedId { stage: "P7", order: 121, id: "edit.autoAlignLayers" },
        StagedId { stage: "P7", order: 122, id: "edit.autoBlendLayers" },
        StagedId { stage: "P7", order: 123, id: "file.automate.photomerge" },
        StagedId { stage: "P7", order: 124, id: "file.automate.mergeToHdrPro" },
        StagedId { stage: "P7", order: 125, id: "file.automate.cropAndStraightenPhotos" },
        // ---- U56 画板、框架与切片。导出到本地文件夹属 scope 的明确边界（需要宿主端口），
        //      不在此声明命令，仍由工作流清单以「无内核命令 + 固定原因」暴露给界面。
        StagedId { stage: "P7", order: 126, id: "layer.new.artboard" },
        StagedId { stage: "P7", order: 127, id: "layer.new.artboardFromLayers" },
        StagedId { stage: "P7", order: 128, id: "layer.artboard.set" },
        StagedId { stage: "P7", order: 129, id: "layer.new.frame" },
        StagedId { stage: "P7", order: 130, id: "layer.new.frameFromLayers" },
        StagedId { stage: "P7", order: 131, id: "slice.new" },
        StagedId { stage: "P7", order: 132, id: "slice.fromGuides" },
        StagedId { stage: "P7", order: 133, id: "layer.newLayerBasedSlice" },
        StagedId { stage: "P7", order: 134, id: "slice.list" },
    ],
};
