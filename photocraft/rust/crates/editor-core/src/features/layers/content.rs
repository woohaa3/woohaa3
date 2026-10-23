use super::*;

pub(super) fn blend_name(blend: BlendMode) -> &'static str {
    photocraft_project_verify::blend_modes::canonical_blend_name(blend).unwrap_or("unsupported")
}

/// 渐变几何的规范名（小写连字符，与协议 `IMAGE_PROJECT_GRADIENT_STYLES` 同值）。
///
/// 用显式映射而不是 `{:?}`：调试输出的大小写属于 Rust 调试格式，不是契约；两端指纹
/// 必须逐字节一致，所以这里和混合模式一样取规范小写名。
fn gradient_style_name(style: photocraft_doc::GradientStyle) -> &'static str {
    use photocraft_doc::GradientStyle;
    match style {
        GradientStyle::Linear => "linear",
        GradientStyle::Radial => "radial",
        GradientStyle::Angle => "angle",
        GradientStyle::Reflected => "reflected",
        GradientStyle::Diamond => "diamond",
    }
}


/// U57：填充层的规范内容（纯色/渐变/图案）。
///
/// 填充层是**可重编内容**：像素是参数算出来的缓存，改成 `#112233` → `#ff8800` 必须让宿主看到
/// 净变化。因此这里描述参数本身，而不是渲染结果。形状与调整层的 `content` 一致：
/// `{kind, parameters:{kind, …}}`，宿主据此比较、报告与重开。
///
/// 由 `document_content.rs` 的 `LayerContent::Fill` 分支写入图层的 `fillLayer` 字段
/// （不复用 `fill`：后者是填充**不透明度**，早已是内容的一部分）。三处必须同源：
/// 本函数、`identity.rs::canonicalize_layer` 的 `"fill"` 分支、TS
/// `features/shared/content.ts` 的 `canonicalizeFillContent`。
pub(crate) fn fill_content(fill: &photocraft_doc::Fill) -> Value {
    use photocraft_doc::Fill;
    match fill {
        Fill::Solid(value) => json!({
            "kind": "solid",
            // 三种填充的 `parameters.kind` 都必须与 `kind` 相同：两端校验器靠它确认「这确实是
            // 该种类」，缺了就变成「无法判定」，宿主会拒绝一切纯色填充。
            "parameters": { "kind": "solid", "color": hex_color(*value), "alpha": value.alpha },
        }),
        Fill::Gradient {
            stops, angle, scale, style, reverse, opacity_stops, midpoints, offset, dither, align,
        } => json!({
            "kind": "gradient",
            "parameters": {
                "kind": "gradient",
                // 端点按 `(位置, 颜色)` 记录；位置是 0–1 的规范值。
                "stops": stops.iter()
                    .map(|(at, value)| json!({ "at": at, "color": hex_color(*value), "alpha": value.alpha }))
                    .collect::<Vec<_>>(),
                "angle": angle,
                "scale": scale,
                "style": gradient_style_name(*style),
                "reverse": reverse,
                "opacityStops": opacity_stops.iter()
                    .map(|(at, alpha)| json!({ "at": at, "alpha": alpha }))
                    .collect::<Vec<_>>(),
                "midpoints": midpoints,
                "offset": [offset.0, offset.1],
                "dither": dither,
                "align": align,
            }
        }),
        Fill::Pattern { name, scale, id, angle, link, phase } => json!({
            "kind": "pattern",
            "parameters": {
                "kind": "pattern",
                // 引用图案的 **id**（图案库键）而不是像素：改库项必须是另一次改动。
                "pattern": id,
                "name": name,
                "scale": scale,
                "angle": angle,
                "link": link,
                "phase": [phase.0, phase.1],
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, Fill, GradientStyle};

    #[test]
    fn each_fill_kind_describes_its_parameters_not_pixels() {
        let solid = fill_content(&Fill::Solid(Color::rgba(0.2, 0.4, 0.6, 0.5)));
        assert_eq!(solid["kind"], "solid");
        // `parameters.kind` 必须同值：两端规范化器靠它确认种类，缺失会变成「无法判定」。
        assert_eq!(solid["parameters"]["kind"], "solid");
        assert_eq!(solid["parameters"]["color"], "#336699");
        assert_eq!(solid["parameters"]["alpha"], 0.5);

        let gradient = fill_content(&Fill::gradient(
            vec![(0.0, Color::WHITE), (1.0, Color::BLACK)],
            45.0,
            1.0,
            GradientStyle::Linear,
            false,
        ));
        assert_eq!(gradient["kind"], "gradient");
        assert_eq!(gradient["parameters"]["kind"], "gradient");
        assert_eq!(gradient["parameters"]["stops"].as_array().unwrap().len(), 2);
        assert_eq!(gradient["parameters"]["angle"], 45.0);
        // 规范小写名而不是 Rust 调试名：跨语言指纹必须逐字节一致。
        assert_eq!(gradient["parameters"]["style"], "linear");

        let pattern = fill_content(&Fill::Pattern {
            name: "格子".into(),
            scale: 1.0,
            id: "grid".into(),
            angle: 0.0,
            link: true,
            phase: (2.0, 3.0),
        });
        assert_eq!(pattern["kind"], "pattern");
        assert_eq!(pattern["parameters"]["pattern"], "grid");
        assert_eq!(pattern["parameters"]["phase"], json!([2.0, 3.0]));
    }

    /// 同一函数必须对不同参数给出不同描述：否则接进内容身份后仍看不出改动。
    #[test]
    fn different_parameters_produce_different_content() {
        let a = fill_content(&Fill::Solid(Color::rgb(0.06, 0.13, 0.20)));
        let b = fill_content(&Fill::Solid(Color::rgb(1.0, 0.53, 0.0)));
        assert_ne!(a, b, "改填充颜色必须改变规范内容");

        let gradient = |angle: f32| fill_content(&Fill::gradient(
            vec![(0.0, Color::WHITE), (1.0, Color::BLACK)],
            angle,
            1.0,
            GradientStyle::Linear,
            false,
        ));
        assert_ne!(gradient(0.0), gradient(90.0), "改渐变角度必须改变规范内容");

        let pattern = |scale: f32| fill_content(&Fill::Pattern {
            name: "格子".into(), scale, id: "grid".into(), angle: 0.0, link: true, phase: (0.0, 0.0),
        });
        assert_ne!(pattern(1.0), pattern(2.0), "改图案缩放必须改变规范内容");
    }
}
