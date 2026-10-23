//! 滤镜域（U46–U49）：逐命令清单、参数/几何校验、滤镜库组合、草稿与重复上次。
//!
//! 本域只登记**已验收**的生产命令；命令清单（[`catalog`]）是参数 schema 的唯一来源，
//! 参数范围直接从上游注册表的命令记法解析，因此面板与内核不会写出两套范围。

use super::{FeatureContribution, StagedId};

pub mod catalog;
pub mod gallery;
pub mod geometry;

// 草稿类型由 `crate::retouch` 以 `#[path]` 收编（共享 `Editor::filter_draft` 字段引用它），
// 这里只做转发，避免同一份源码被编进两个模块后出现两个 `FilterDraft`。
pub use crate::retouch::{FilterDraft, validate_filter};

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "filters",
    capabilities: &[
        StagedId { stage: "P6", order: 3, id: "filter.blur-gaussian" },
        StagedId { stage: "P6", order: 4, id: "filter.sharpen-usm" },
    ],
    commands: &[
        // 一项一步：清单顺序即面板顺序，`filter.lastFilter` 固定在最后。
        StagedId { stage: "P6", order: 9, id: "filter.blur.gaussianBlur" },
        StagedId { stage: "P6", order: 10, id: "filter.sharpen.unsharpMask" },
        StagedId { stage: "P6", order: 11, id: "filter.lastFilter" },
        StagedId { stage: "P6", order: 12, id: "filter.sharpen.sharpen" },
        StagedId { stage: "P6", order: 13, id: "filter.sharpen.sharpenMore" },
        StagedId { stage: "P6", order: 14, id: "filter.sharpen.sharpenEdges" },
        StagedId { stage: "P6", order: 15, id: "filter.sharpen.smartSharpen" },
        StagedId { stage: "P6", order: 16, id: "filter.blur.blur" },
        StagedId { stage: "P6", order: 17, id: "filter.blur.blurMore" },
        StagedId { stage: "P6", order: 18, id: "filter.blur.boxBlur" },
        StagedId { stage: "P6", order: 19, id: "filter.blur.motionBlur" },
        StagedId { stage: "P6", order: 20, id: "filter.blur.radialBlur" },
        StagedId { stage: "P6", order: 21, id: "filter.blur.surfaceBlur" },
        StagedId { stage: "P6", order: 22, id: "filter.blur.smartBlur" },
        StagedId { stage: "P6", order: 23, id: "filter.blur.shapeBlur" },
        StagedId { stage: "P6", order: 24, id: "filter.blur.lensBlur" },
        StagedId { stage: "P6", order: 25, id: "filter.blur.average" },
        StagedId { stage: "P6", order: 26, id: "filter.noise.addNoise" },
        StagedId { stage: "P6", order: 27, id: "filter.noise.despeckle" },
        StagedId { stage: "P6", order: 28, id: "filter.noise.dustAndScratches" },
        StagedId { stage: "P6", order: 29, id: "filter.noise.median" },
        StagedId { stage: "P6", order: 30, id: "filter.noise.reduceNoise" },
        StagedId { stage: "P6", order: 31, id: "filter.pixelate.mosaic" },
        StagedId { stage: "P6", order: 32, id: "filter.pixelate.crystallize" },
        StagedId { stage: "P6", order: 33, id: "filter.pixelate.colorHalftone" },
        StagedId { stage: "P6", order: 34, id: "filter.pixelate.mezzotint" },
        StagedId { stage: "P6", order: 35, id: "filter.pixelate.pointillize" },
        StagedId { stage: "P6", order: 36, id: "filter.pixelate.facet" },
        StagedId { stage: "P6", order: 37, id: "filter.pixelate.fragment" },
        StagedId { stage: "P6", order: 38, id: "filter.distort.wave" },
        StagedId { stage: "P6", order: 39, id: "filter.distort.ripple" },
        StagedId { stage: "P6", order: 40, id: "filter.distort.twirl" },
        StagedId { stage: "P6", order: 41, id: "filter.distort.spherize" },
        StagedId { stage: "P6", order: 42, id: "filter.distort.pinch" },
        StagedId { stage: "P6", order: 43, id: "filter.distort.zigZag" },
        StagedId { stage: "P6", order: 44, id: "filter.distort.shear" },
        StagedId { stage: "P6", order: 45, id: "filter.distort.polarCoordinates" },
        StagedId { stage: "P6", order: 46, id: "filter.distort.displace" },
        StagedId { stage: "P6", order: 47, id: "filter.stylize.emboss" },
        StagedId { stage: "P6", order: 48, id: "filter.stylize.findEdges" },
        StagedId { stage: "P6", order: 49, id: "filter.stylize.solarize" },
        StagedId { stage: "P6", order: 50, id: "filter.stylize.diffuse" },
        StagedId { stage: "P6", order: 51, id: "filter.stylize.extrude" },
        StagedId { stage: "P6", order: 52, id: "filter.stylize.oilPaint" },
        StagedId { stage: "P6", order: 53, id: "filter.stylize.tiles" },
        StagedId { stage: "P6", order: 54, id: "filter.stylize.traceContour" },
        StagedId { stage: "P6", order: 55, id: "filter.stylize.wind" },
        StagedId { stage: "P6", order: 56, id: "filter.render.clouds" },
        StagedId { stage: "P6", order: 57, id: "filter.render.differenceClouds" },
        StagedId { stage: "P6", order: 58, id: "filter.render.fibers" },
        StagedId { stage: "P6", order: 59, id: "filter.render.lensFlare" },
        StagedId { stage: "P6", order: 60, id: "filter.render.lightingEffects" },
        StagedId { stage: "P6", order: 61, id: "filter.render.relight" },
        StagedId { stage: "P6", order: 62, id: "filter.render.flame" },
        StagedId { stage: "P6", order: 63, id: "filter.render.pictureFrame" },
        StagedId { stage: "P6", order: 64, id: "filter.render.tree" },
        StagedId { stage: "P6", order: 65, id: "filter.other.highPass" },
        StagedId { stage: "P6", order: 66, id: "filter.other.minimum" },
        StagedId { stage: "P6", order: 67, id: "filter.other.maximum" },
        StagedId { stage: "P6", order: 68, id: "filter.other.offset" },
        StagedId { stage: "P6", order: 69, id: "filter.other.custom" },
        StagedId { stage: "P6", order: 70, id: "filter.other.hsbHsl" },
        StagedId { stage: "P6", order: 71, id: "filter.other.colorToAlpha" },
        StagedId { stage: "P6", order: 72, id: "filter.video.deInterlace" },
        StagedId { stage: "P6", order: 73, id: "filter.video.ntscColors" },
        StagedId { stage: "P6", order: 74, id: "filter.filterGallery" },
        StagedId { stage: "P6", order: 75, id: "filter.gallery.coloredPencil" },
        StagedId { stage: "P6", order: 76, id: "filter.gallery.cutout" },
        StagedId { stage: "P6", order: 77, id: "filter.gallery.dryBrush" },
        StagedId { stage: "P6", order: 78, id: "filter.gallery.filmGrain" },
        StagedId { stage: "P6", order: 79, id: "filter.gallery.fresco" },
        StagedId { stage: "P6", order: 80, id: "filter.gallery.neonGlow" },
        StagedId { stage: "P6", order: 81, id: "filter.gallery.paintDaubs" },
        StagedId { stage: "P6", order: 82, id: "filter.gallery.paletteKnife" },
        StagedId { stage: "P6", order: 83, id: "filter.gallery.plasticWrap" },
        StagedId { stage: "P6", order: 84, id: "filter.gallery.posterEdges" },
        StagedId { stage: "P6", order: 85, id: "filter.gallery.roughPastels" },
        StagedId { stage: "P6", order: 86, id: "filter.gallery.smudgeStick" },
        StagedId { stage: "P6", order: 87, id: "filter.gallery.sponge" },
        StagedId { stage: "P6", order: 88, id: "filter.gallery.underpainting" },
        StagedId { stage: "P6", order: 89, id: "filter.gallery.watercolor" },
        StagedId { stage: "P6", order: 90, id: "filter.gallery.accentedEdges" },
        StagedId { stage: "P6", order: 91, id: "filter.gallery.angledStrokes" },
        StagedId { stage: "P6", order: 92, id: "filter.gallery.crosshatch" },
        StagedId { stage: "P6", order: 93, id: "filter.gallery.darkStrokes" },
        StagedId { stage: "P6", order: 94, id: "filter.gallery.inkOutlines" },
        StagedId { stage: "P6", order: 95, id: "filter.gallery.spatter" },
        StagedId { stage: "P6", order: 96, id: "filter.gallery.sprayedStrokes" },
        StagedId { stage: "P6", order: 97, id: "filter.gallery.sumiE" },
        StagedId { stage: "P6", order: 98, id: "filter.gallery.diffuseGlow" },
        StagedId { stage: "P6", order: 99, id: "filter.gallery.glass" },
        StagedId { stage: "P6", order: 100, id: "filter.gallery.oceanRipple" },
        StagedId { stage: "P6", order: 101, id: "filter.gallery.basRelief" },
        StagedId { stage: "P6", order: 102, id: "filter.gallery.chalkCharcoal" },
        StagedId { stage: "P6", order: 103, id: "filter.gallery.charcoal" },
        StagedId { stage: "P6", order: 104, id: "filter.gallery.chrome" },
        StagedId { stage: "P6", order: 105, id: "filter.gallery.conteCrayon" },
        StagedId { stage: "P6", order: 106, id: "filter.gallery.graphicPen" },
        StagedId { stage: "P6", order: 107, id: "filter.gallery.halftonePattern" },
        StagedId { stage: "P6", order: 108, id: "filter.gallery.notePaper" },
        StagedId { stage: "P6", order: 109, id: "filter.gallery.photocopy" },
        StagedId { stage: "P6", order: 110, id: "filter.gallery.plaster" },
        StagedId { stage: "P6", order: 111, id: "filter.gallery.reticulation" },
        StagedId { stage: "P6", order: 112, id: "filter.gallery.stamp" },
        StagedId { stage: "P6", order: 113, id: "filter.gallery.tornEdges" },
        StagedId { stage: "P6", order: 114, id: "filter.gallery.waterPaper" },
        StagedId { stage: "P6", order: 115, id: "filter.gallery.craquelure" },
        StagedId { stage: "P6", order: 116, id: "filter.gallery.grain" },
        StagedId { stage: "P6", order: 117, id: "filter.gallery.mosaicTiles" },
        StagedId { stage: "P6", order: 118, id: "filter.gallery.patchwork" },
        StagedId { stage: "P6", order: 119, id: "filter.gallery.stainedGlass" },
        StagedId { stage: "P6", order: 120, id: "filter.gallery.texturizer" },
        StagedId { stage: "P6", order: 121, id: "filter.gallery.glowingEdges" },
        StagedId { stage: "P6", order: 122, id: "filter.blurGallery.tiltShift" },
        StagedId { stage: "P6", order: 123, id: "filter.blurGallery.irisBlur" },
        StagedId { stage: "P6", order: 124, id: "filter.blurGallery.fieldBlur" },
        StagedId { stage: "P6", order: 125, id: "filter.blurGallery.spinBlur" },
        StagedId { stage: "P6", order: 126, id: "filter.blurGallery.pathBlur" },
        StagedId { stage: "P6", order: 127, id: "filter.cameraRaw" },
        StagedId { stage: "P6", order: 128, id: "filter.lensCorrection" },
        StagedId { stage: "P6", order: 129, id: "filter.adaptiveWideAngle" },
        StagedId { stage: "P6", order: 130, id: "filter.vanishingPoint" },
    ],
};

#[cfg(test)]
mod tests {
    use super::*;

    /// 目录与命令白名单必须逐项一致：这是「声明即入口」的自动核对。
    ///
    /// `catalog::ENTRIES` 是面板与内核共用的参数 schema 来源，`CONTRIBUTION.commands` 才是
    /// [`crate::capability::allowed_command_ids`] 真正放行的那一份。两者不一致时会出现两种
    /// 静默故障：清单里有、白名单没有 → 面板画出点不动的滤镜；白名单有、清单没有 → 命令可
    /// 执行但界面无法给出参数。所以这里双向核对，并单独钉住 `filter.lastFilter`（它没有参数
    /// schema，因此不属于目录条目）。
    #[test]
    fn catalogue_and_command_whitelist_agree() {
        let declared: Vec<&str> = catalog::ids().collect();
        let mut whitelisted: Vec<&str> = CONTRIBUTION
            .commands
            .iter()
            .map(|entry| entry.id)
            .filter(|id| *id != "filter.lastFilter")
            .collect();
        whitelisted.sort_unstable();
        let mut sorted = declared.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, whitelisted, "目录与命令白名单必须逐项一致");
        assert_eq!(declared.len(), whitelisted.len(), "目录与白名单项数一致");

        // 「重复上次」没有参数 schema，但必须是白名单里的真实命令。
        assert!(
            CONTRIBUTION.commands.iter().any(|entry| entry.id == "filter.lastFilter"),
            "filter.lastFilter 必须在命令白名单里"
        );
        assert!(!catalog::contains("filter.lastFilter"), "lastFilter 不是目录条目");
    }

    /// 目录条目与上游注册表必须对得上：本域不能凭空登记上游没有的命令。
    #[test]
    fn every_entry_exists_upstream() {
        for id in catalog::ids() {
            assert!(
                photocraft_engine::commands::find(id).is_some(),
                "{id} 在本域清单里，但上游注册表没有这条命令"
            );
        }
    }

    /// 画廊目录的 47 个 key 都必须是「单层画廊滤镜」命令，且都能执行。
    #[test]
    fn gallery_keys_map_to_catalogue_commands() {
        let keys: Vec<&str> = gallery::keys().collect();
        assert_eq!(keys.len(), 47, "画廊目录项数");
        for key in keys {
            let id = format!("filter.gallery.{key}");
            assert!(catalog::contains(&id), "{id} 不在目录里");
            assert!(
                CONTRIBUTION.commands.iter().any(|entry| entry.id == id),
                "{id} 不在命令白名单里"
            );
        }
    }

    /// 每条目录命令都要给出可执行的白名单登记，且 stage 一致（本域全部 P6）。
    #[test]
    fn whitelist_entries_are_all_p6() {
        for entry in CONTRIBUTION.commands {
            assert_eq!(entry.stage, "P6", "{} 应属于 P6", entry.id);
        }
        for entry in CONTRIBUTION.capabilities {
            assert_eq!(entry.stage, "P6", "{} 应属于 P6", entry.id);
        }
    }

    /// 每个 `resource` 参数都必须有人画：只声明不画，用户拿到的就是半套滤镜。
    ///
    /// 这条测试是**穷举**而不是举例：它遍历目录里全部 `resource` 字段，按归属分类，
    /// 未归类的一个都不放过。曾经的漏洞正是「举例式」检查漏掉的——`mapLayer`
    /// （位移图文档里的图层）、切变的 `points`（曲线形状）、画廊的 `glowColor`
    /// 都在内核生效，面板却完全没有控件，却因为没被列进示例而长期没被发现。
    #[test]
    fn structured_params_have_an_owner() {
        // 面板用图内/专用编辑器画的字段（不是通用滑杆）。
        let in_canvas = [
            "pins",              // 模糊画廊控制点
            "paths",             // 路径模糊的路径
            "planes",            // 透视平面
            "constraints",       // 广角约束线
            "straighten",        // 镜头校正拉直线
            "kernel",            // 自定卷积核
            "clone",             // 透视克隆笔迹
            "paste",             // 透视粘贴条目
            "path",              // 火焰跟随的已保存路径名
            "points",            // 切变曲线（[t, offset] 点列表）
            "pointCurve",        // Camera Raw 点曲线
            "pointCurveRed",
            "pointCurveGreen",
            "pointCurveBlue",
            "hslHue",            // Camera Raw 八段 HSL
            "hslSat",
            "hslLum",
            "gradeShadows",      // Camera Raw 分级转盘
            "gradeMidtones",
            "gradeHighlights",
            "gradeGlobal",
            "curveSplits",       // Camera Raw 曲线分离点
            "lights",            // 光照效果光源组
        ];
        // 由会话状态自动注入，不属于用户输入。
        let session_injected = ["foreground", "background"];
        // 内核自己解析来源的旁路入口：本应用一律拒绝本机路径，`mapLayer` 则随
        // `mapDocument` 一起由选择器写入（见下）。
        let engine_bypass = ["mapPath"];
        // 画布编辑器之外的普通选择器（下拉/颜色），仍然是「有控件」。
        let picker = ["mapDocument", "mapLayer", "glowColor"];

        let mut unowned = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for id in catalog::ids() {
            for spec in catalog::params(id) {
                if spec.kind != catalog::ParamKind::Resource {
                    continue;
                }
                let key = spec.key.as_str();
                seen.insert(key.to_string());
                let owned = in_canvas.contains(&key)
                    || session_injected.contains(&key)
                    || engine_bypass.contains(&key)
                    || picker.contains(&key);
                if !owned {
                    unowned.push(format!("{id} 的 {}", spec.key));
                }
            }
        }
        assert!(
            unowned.is_empty(),
            "这些结构型参数声明了却没有归属（面板不会画控件）：{unowned:?}"
        );

        // 反向：归类表里不能有目录早已不声明的字段，否则分类本身在腐坏。
        let declared: std::collections::BTreeSet<&str> = seen.iter().map(String::as_str).collect();
        for key in in_canvas
            .iter()
            .chain(session_injected.iter())
            .chain(engine_bypass.iter())
            .chain(picker.iter())
        {
            assert!(
                declared.contains(key),
                "{key} 已不在任何命令的声明里，归类表要同步删除"
            );
        }

        // 几处「面板必须画」的关键字段单独钉住归属，避免被顺手挪进别的分类。
        for (id, key) in [
            ("filter.cameraRaw", "pointCurve"),
            ("filter.cameraRaw", "hslHue"),
            ("filter.cameraRaw", "gradeShadows"),
            ("filter.cameraRaw", "curveSplits"),
            ("filter.render.lightingEffects", "lights"),
            ("filter.vanishingPoint", "clone"),
            ("filter.vanishingPoint", "paste"),
            ("filter.render.flame", "path"),
            ("filter.distort.shear", "points"),
            ("filter.distort.displace", "mapLayer"),
            ("filter.gallery.neonGlow", "glowColor"),
        ] {
            assert!(
                catalog::params(id).iter().any(|spec| spec.key == key && spec.kind == catalog::ParamKind::Resource),
                "{id} 的 {key} 必须是结构型参数，面板据此决定渲染哪一组编辑器"
            );
        }
    }

    /// 本 change 只新增命令，不新增 capability id。
    #[test]
    fn no_new_capability_ids() {
        let ids: Vec<&str> = CONTRIBUTION.capabilities.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, vec!["filter.blur-gaussian", "filter.sharpen-usm"]);
    }
}
