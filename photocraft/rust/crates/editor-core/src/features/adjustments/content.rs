use super::*;
use crate::features::adjustments::direct_adjustment::HUE_RANGES;

/// 调整层的内容投影（工程内容、PSD 往返与内容指纹共用这一份规范形状）。
///
/// 每个**已实现**的调整类型都投影出自己的 `kind` 与完整持久参数（与内核 `to_params` 同一套键，
/// 见 `photocraft_engine::adjust_params`）；绝不把未知类型折叠成另一种调整——那会让两个不同的
/// 调整层得到相同的内容投影与相同指纹。
///
/// 本 change 的实现范围到 15 类逐类调整为止（`direct_adjustment::ADJUSTMENT_KINDS`）。LUT
/// （`color-lookup`）与无法求值的 PSD 块（`unsupported`）不在范围内：它们投影成各自的可判定
/// 标记，`identity::canonicalize_adjustment` 会因此判为「无法判定」，而不是猜成某个已知调整。
pub(super) fn adjustment_content(adjustment: &Adjustment) -> Value {
    match adjustment {
        Adjustment::BrightnessContrast { brightness, contrast, .. } => json!({
            "kind": "brightness-contrast",
            "parameters": { "kind": "brightness-contrast", "brightness": brightness, "contrast": contrast }
        }),
        Adjustment::HueSaturation { hue, saturation, lightness, colorize, ranges, .. } => {
            let mut parameters = json!({
                "kind": "hue-saturation",
                "hue": hue,
                "saturation": saturation,
                "lightness": lightness,
                // Colorize 是持久参数（U42）：只差着色的两层不能投影成同一份内容。
                "colorize": colorize,
            });
            // 六个色域是持久参数（U42）：不投影就会让「只改某个色域」的两层判为同内容。
            for (key, range) in HUE_RANGES.iter().zip(ranges.iter()) {
                parameters[*key] = json!({
                    "hue": range.hue,
                    "saturation": range.saturation,
                    "lightness": range.lightness,
                    "range": range.bounds,
                });
            }
            json!({ "kind": "hue-saturation", "parameters": parameters })
        }
        Adjustment::Curves { master, pencil, .. } => json!({
            "kind": "curves",
            "parameters": {
                "kind": "curves",
                "rgb": master.iter().map(|point| json!({ "x": point.input, "y": point.output })).collect::<Vec<_>>(),
                // 铅笔曲线的映射是持久参数（U41）：同一条样条的点模式与铅笔模式不是同一内容。
                "pencil": pencil,
            }
        }),
        // P5 新区四类：参数是规范内容，重开与 PSD 往返都要保持。
        Adjustment::Levels { master, per_channel, .. } => {
            // 五个端点全进内容投影：只投影输入端点会让「只改输出端点」的两层判为同内容
            // （U41 新增的输出黑/白场正是这种持久参数）。
            //
            // 单位取**参数语义**（0–255，与内核 `to_params`/`levels_obj` 一致），不是存储的
            // 0–1：协议侧 `ImageProjectLevelsChannel` 与 `canonicalizeAdjustment` 按 0–255
            // 校验，投影若留在 0–1 会让同一份工程在两端算出不同身份。
            let channel = |value: &photocraft_doc::adjust::LevelsChannel| {
                let level = |value: f32| (value * 255.0 * 100.0).round() / 100.0;
                json!({
                    "inBlack": level(value.in_black),
                    "gamma": (value.gamma * 1000.0).round() / 1000.0,
                    "inWhite": level(value.in_white),
                    "outBlack": level(value.out_black),
                    "outWhite": level(value.out_white),
                })
            };
            json!({
                "kind": "levels",
                "parameters": {
                    "kind": "levels",
                    "master": channel(master),
                    "red": channel(&per_channel[0]),
                    "green": channel(&per_channel[1]),
                    "blue": channel(&per_channel[2]),
                }
            })
        }
        Adjustment::Vibrance { vibrance, saturation } => json!({
            "kind": "vibrance",
            "parameters": { "kind": "vibrance", "vibrance": vibrance, "saturation": saturation }
        }),
        Adjustment::BlackWhite { weights, tint } => json!({
            "kind": "black-white",
            "parameters": {
                "kind": "black-white",
                "reds": weights[0],
                "yellows": weights[1],
                "greens": weights[2],
                "cyans": weights[3],
                "blues": weights[4],
                "magentas": weights[5],
                "tint": tint.map(|color| hex_color(photocraft_doc::Color::rgb(color[0], color[1], color[2]))),
            }
        }),
        // U43：九类新增逐类调整。参数形状与内核 `to_params` 一致（百分数/图层级单位），
        // 这样发布后的重开、PSD 往返与内容投影读的是同一份数值。
        Adjustment::Exposure { exposure, offset, gamma } => json!({
            "kind": "exposure",
            "parameters": { "kind": "exposure", "exposure": exposure, "offset": offset, "gamma": gamma }
        }),
        Adjustment::ColorBalance { shadows, midtones, highlights, preserve_luminosity } => json!({
            "kind": "color-balance",
            "parameters": {
                "kind": "color-balance",
                "shadows": shadows,
                "midtones": midtones,
                "highlights": highlights,
                "preserveLuminosity": preserve_luminosity,
            }
        }),
        Adjustment::PhotoFilter { color, density, preserve_luminosity } => json!({
            "kind": "photo-filter",
            "parameters": {
                "kind": "photo-filter",
                "color": hex_color(photocraft_doc::Color::rgb(color[0], color[1], color[2])),
                // 与 `to_params` 相同的 0.1% 网格，避免浮点尾数把同一参数算成两种内容。
                "density": (density * 1000.0).round() / 10.0,
                "preserveLuminosity": preserve_luminosity,
            }
        }),
        Adjustment::ChannelMixer { matrix, monochrome } => {
            let row = |values: &[f32; 4]| json!(values.map(|value| (value * 1000.0).round() / 10.0));
            json!({
                "kind": "channel-mixer",
                "parameters": {
                    "kind": "channel-mixer",
                    "red": row(&matrix[0]),
                    "green": row(&matrix[1]),
                    "blue": row(&matrix[2]),
                    "monochrome": monochrome,
                }
            })
        }
        Adjustment::Invert => json!({ "kind": "invert", "parameters": { "kind": "invert" } }),
        Adjustment::Posterize { levels } => json!({
            "kind": "posterize",
            "parameters": { "kind": "posterize", "levels": levels }
        }),
        // 阈值存储是 0–1，参数语义是 0–255 级（与 `to_params` 一致）。
        Adjustment::Threshold { level } => json!({
            "kind": "threshold",
            "parameters": { "kind": "threshold", "level": (level * 255.0).round() }
        }),
        Adjustment::GradientMap { stops, reverse, dither } => json!({
            "kind": "gradient-map",
            "parameters": {
                "kind": "gradient-map",
                "stops": stops.iter().map(|(position, color)| {
                    json!([position, hex_color(photocraft_doc::Color::rgb(color[0], color[1], color[2]))])
                }).collect::<Vec<_>>(),
                "reverse": reverse,
                "dither": dither,
            }
        }),
        Adjustment::SelectiveColor { relative, adjustments } => {
            let mut parameters = json!({
                "kind": "selective-color",
                "method": if *relative { "relative" } else { "absolute" },
            });
            for (index, key) in ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"]
                .iter()
                .enumerate()
            {
                parameters[*key] = json!(adjustments[index]);
            }
            json!({ "kind": "selective-color", "parameters": parameters })
        }
        // 范围外：LUT 与无法求值的 PSD 块。投影成各自的可判定标记，绝不冒充某个已知调整。
        Adjustment::ColorLookup { tetrahedral, dither, .. } => json!({
            "kind": "color-lookup",
            "parameters": {
                "kind": "color-lookup",
                "interpolation": if *tetrahedral { "tetrahedral" } else { "trilinear" },
                "dither": dither,
            }
        }),
        Adjustment::Unsupported { psd_key, raw } => json!({
            "kind": "unsupported",
            "parameters": {
                "kind": "unsupported",
                "psdKey": psd_key,
                "rawHash": crate::identity::fnv1a64_hex(&String::from_utf8_lossy(raw)),
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(adjustment: &Adjustment) -> String {
        adjustment_content(adjustment)["kind"].as_str().unwrap().to_string()
    }

    #[test]
    fn every_implemented_kind_projects_its_own_kind_and_parameters() {
        // 逐类调整必须投影出自己的 kind：折叠成同一个占位会让两个不同的调整层得到同一内容身份。
        let cases = [
            (Adjustment::Exposure { exposure: 1.0, offset: 0.0, gamma: 1.0 }, "exposure"),
            (Adjustment::ColorBalance { shadows: [1.0, -1.0, 0.0], midtones: [0.0; 3], highlights: [0.0; 3], preserve_luminosity: true }, "color-balance"),
            (Adjustment::PhotoFilter { color: [1.0, 0.5, 0.0], density: 0.25, preserve_luminosity: true }, "photo-filter"),
            (Adjustment::ChannelMixer { matrix: [[0.4, 0.4, 0.2, 0.0], [0.3, 0.6, 0.1, 0.0], [0.2, 0.2, 0.6, 0.0]], monochrome: false }, "channel-mixer"),
            (Adjustment::Invert, "invert"),
            (Adjustment::Posterize { levels: 6 }, "posterize"),
            (Adjustment::Threshold { level: 0.5 }, "threshold"),
            (Adjustment::GradientMap { stops: vec![(0.0, [0.0, 0.0, 0.0]), (1.0, [1.0, 1.0, 1.0])], reverse: false, dither: true }, "gradient-map"),
            (Adjustment::SelectiveColor { relative: true, adjustments: [[0.0; 4]; 9] }, "selective-color"),
        ];
        for (adjustment, expected) in cases {
            let content = adjustment_content(&adjustment);
            assert_eq!(content["kind"], expected, "{expected}");
            assert_eq!(content["parameters"]["kind"], expected, "{expected}");
        }
        // 投影互不相同：没有任何两个实现的类型落成同一份内容。
        let mut kinds: Vec<String> = [
            Adjustment::Exposure { exposure: 0.0, offset: 0.0, gamma: 1.0 },
            Adjustment::ColorBalance { shadows: [0.0; 3], midtones: [0.0; 3], highlights: [0.0; 3], preserve_luminosity: false },
            Adjustment::Invert,
            Adjustment::Posterize { levels: 2 },
            Adjustment::Threshold { level: 0.5 },
        ].iter().map(kind_of).collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), 5);
    }

    #[test]
    fn parameter_differences_survive_the_projection() {
        // 只差一个持久参数的两种调整层不能投影成同一份内容。
        let neutral = adjustment_content(&Adjustment::Levels {
            master: Default::default(), per_channel: std::array::from_fn(|_| Default::default()), space: Default::default(), black: Default::default(),
        });
        let with_output = adjustment_content(&Adjustment::Levels {
            master: photocraft_doc::adjust::LevelsChannel { out_white: 0.7, ..Default::default() },
            per_channel: std::array::from_fn(|_| Default::default()), space: Default::default(), black: Default::default(),
        });
        assert_ne!(neutral, with_output, "输出端点必须进入内容投影");

        let plain = adjustment_content(&Adjustment::HueSaturation {
            hue: 0.0, saturation: 0.0, lightness: 0.0, colorize: false,
            ranges: photocraft_doc::adjust::HueRange::defaults(),
        });
        let mut ranges = photocraft_doc::adjust::HueRange::defaults();
        ranges[0].saturation = -40.0;
        let ranged = adjustment_content(&Adjustment::HueSaturation {
            hue: 0.0, saturation: 0.0, lightness: 0.0, colorize: false, ranges,
        });
        assert_ne!(plain, ranged, "单色域参数必须进入内容投影");
    }

    #[test]
    fn out_of_scope_adjustments_are_marked_as_themselves_not_disguised() {
        // LUT 与无法求值的 PSD 块不在本 change 范围：投影成各自的可判定标记，
        // 而不是冒充亮度/对比度（那会让它们的身份与一个中性调整撞车）。
        let lut = adjustment_content(&Adjustment::ColorLookup {
            name: "Look.cube".into(), lut: None, size: 2, tetrahedral: false, dither: false,
        });
        assert_eq!(lut["kind"], "color-lookup");
        let unsupported = adjustment_content(&Adjustment::Unsupported { psd_key: "grdm".into(), raw: vec![1, 2, 3] });
        assert_eq!(unsupported["kind"], "unsupported");
        assert_eq!(unsupported["parameters"]["psdKey"], "grdm");
        assert_eq!(unsupported["parameters"]["rawHash"].as_str().map(str::len), Some(16));
    }
}
