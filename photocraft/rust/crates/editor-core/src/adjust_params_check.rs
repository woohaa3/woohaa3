//! 破坏性图像调整的严格参数校验。
//!
//! 固定引擎在若干调整参数上做夹紧（例如色阶数、阈值）；界面已按公开范围校验，但直接命令调用
//! 仍须得到一致的拒绝，而不是悄悄换成另一个结果。这里只校验已经开放的 `image.adjustments.*`
//! 与 `image.auto*`，不复制像素算法。

use serde_json::Value;

fn finite(params: &Value, key: &str, min: f64, max: f64) -> bool {
    params.get(key).is_none_or(|value| value.as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max))
}

fn boolean(params: &Value, key: &str) -> bool {
    params.get(key).is_none_or(Value::is_boolean)
}

fn no_extra(params: &Value, allowed: &[&str]) -> bool {
    params.as_object().is_some_and(|fields| fields.keys().all(|key| allowed.contains(&key.as_str())))
}

fn color(params: &Value, key: &str) -> bool {
    params.get(key).is_none_or(|value| {
        value.as_str().is_some_and(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
    })
}

fn triple(params: &Value, key: &str, min: f64, max: f64) -> bool {
    params.get(key).is_none_or(|value| {
        value.as_array().is_some_and(|items| {
            items.len() == 3
                && items.iter().all(|item| item.as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max))
        })
    })
}

fn quad(params: &Value, key: &str, min: f64, max: f64) -> bool {
    params.get(key).is_none_or(|value| {
        value.as_array().is_some_and(|items| {
            items.len() == 4
                && items.iter().all(|item| item.as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max))
        })
    })
}

/// 返回拒绝原因；`None` 表示参数在公开范围内。
pub(crate) fn invalid(id: &str, params: &Value) -> Option<String> {
    if id == "edit.fade" {
        if !params.is_object() {
            return Some("淡化参数必须为对象（edit.fade）".into());
        }
        let opacity = params.get("opacity");
        if opacity.is_some_and(|value| value.as_f64().is_none_or(|n| !n.is_finite() || !(0.0..=100.0).contains(&n))) {
            return Some("淡化不透明度须为 0–100（edit.fade）".into());
        }
        if params.get("mode").is_some_and(|value| value.as_str().is_none()) {
            return Some("淡化混合模式须为字符串（edit.fade）".into());
        }
        return None;
    }
    let kind = id.strip_prefix("image.adjustments.")?;
    let bad = |message: &str| Some(format!("{message}（{id}）"));
    if !params.is_object() {
        return Some(format!("调整参数必须为对象（{id}）"));
    }
    match kind {
        "brightnessContrast" => {
            if !no_extra(params, &["brightness", "contrast", "legacy"])
                || !finite(params, "brightness", -150.0, 150.0)
                || !finite(params, "contrast", -50.0, 100.0)
                || !boolean(params, "legacy") {
                return bad("亮度/对比度参数无效");
            }
        }
        "curves" => {
            if !no_extra(params, &["points"]) {
                return bad("曲线参数包含未知字段");
            }
            if let Some(points) = params.get("points") {
                if let Err(error) = crate::adjustment_preview::validate_points(points) {
                    return bad(&error.to_string());
                }
            }
        }
        "invert" | "desaturate" | "equalize" => {
            if !no_extra(params, &[]) {
                return bad("该调整不接受参数");
            }
        }
        "levels" => {
            if !no_extra(params, &["inBlack", "gamma", "inWhite", "outBlack", "outWhite", "red", "green", "blue"]) {
                return bad("色阶参数包含未知字段");
            }
            if !finite(params, "inBlack", 0.0, 253.0) || !finite(params, "inWhite", 2.0, 255.0)
                || !finite(params, "outBlack", 0.0, 255.0) || !finite(params, "outWhite", 0.0, 255.0)
                || !finite(params, "gamma", 0.01, 9.99) {
                return bad("色阶数值超出范围");
            }
        }
        "exposure" => {
            if !finite(params, "exposure", -20.0, 20.0) || !finite(params, "offset", -0.5, 0.5) || !finite(params, "gamma", 0.01, 9.99) {
                return bad("曝光数值超出范围");
            }
        }
        "vibrance" => {
            if !finite(params, "vibrance", -100.0, 100.0) || !finite(params, "saturation", -100.0, 100.0) {
                return bad("自然饱和度数值超出范围");
            }
        }
        "hueSaturation" => {
            if !finite(params, "hue", -180.0, 180.0) || !finite(params, "saturation", -100.0, 100.0) || !finite(params, "lightness", -100.0, 100.0) || !boolean(params, "colorize") {
                return bad("色相/饱和度数值超出范围");
            }
        }
        "colorBalance" => {
            for key in ["shadows", "midtones", "highlights"] {
                if !triple(params, key, -100.0, 100.0) {
                    return bad("色彩平衡分量超出范围");
                }
            }
            if !boolean(params, "preserveLuminosity") {
                return bad("色彩平衡布尔参数无效");
            }
        }
        "blackWhite" => {
            for key in ["reds", "yellows", "greens", "cyans", "blues", "magentas"] {
                if !finite(params, key, -200.0, 300.0) {
                    return bad("黑白混合比例超出范围");
                }
            }
            if !boolean(params, "tint") || !color(params, "tintColor") {
                return bad("黑白色调参数无效");
            }
        }
        "photoFilter" => {
            if !finite(params, "density", 0.0, 100.0) || !boolean(params, "preserveLuminosity") || !color(params, "color") {
                return bad("照片滤镜参数无效");
            }
        }
        "channelMixer" => {
            for key in ["red", "green", "blue", "gray"] {
                if !quad(params, key, -200.0, 200.0) {
                    return bad("通道混合器分量超出范围");
                }
            }
            if !boolean(params, "monochrome") {
                return bad("通道混合器布尔参数无效");
            }
        }
        "posterize" => {
            if !finite(params, "levels", 2.0, 255.0) {
                return bad("色调分离色阶须为 2–255");
            }
        }
        "threshold" => {
            if !finite(params, "level", 1.0, 255.0) {
                return bad("阈值色阶须为 1–255");
            }
        }
        "gradientMap" => {
            let stops = params.get("stops");
            let valid = stops.is_none_or(|value| {
                value.as_array().is_some_and(|items| {
                    items.len() >= 2
                        && items.len() <= 64
                        && items.iter().all(|stop| {
                            stop.as_array().is_some_and(|pair| {
                                pair.len() == 2
                                    && pair[0].as_f64().is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                                    && pair[1].as_str().is_some_and(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
                            })
                        })
                })
            });
            if !valid || !boolean(params, "reverse") || !boolean(params, "dither") {
                return bad("渐变映射色标无效");
            }
        }
        "selectiveColor" => {
            for key in ["cyan", "magenta", "yellow", "black"] {
                if !finite(params, key, -100.0, 100.0) {
                    return bad("可选颜色分量超出范围");
                }
            }
            if params.get("method").is_some_and(|value| !matches!(value.as_str(), Some("relative" | "absolute"))) {
                return bad("可选颜色方法无效");
            }
            if params.get("colors").is_some_and(|value| {
                !matches!(value.as_str(), Some("reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas" | "whites" | "neutrals" | "blacks"))
            }) {
                return bad("可选颜色范围无效");
            }
        }
        _ => return Some(format!("未开放的调整类型（{id}）")),
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_out_of_range_adjustments_before_writing() {
        assert!(invalid("image.adjustments.posterize", &json!({"levels":1})).is_some());
        assert!(invalid("image.adjustments.posterize", &json!({"levels":4})).is_none());
        assert!(invalid("image.adjustments.threshold", &json!({"level":0})).is_some());
        assert!(invalid("image.adjustments.invert", &json!({})).is_none());
        assert!(invalid("image.adjustments.invert", &json!({"levels":4})).is_some());
        assert!(invalid("image.adjustments.colorBalance", &json!({"midtones":[0,0]})).is_some());
        assert!(invalid("image.adjustments.photoFilter", &json!({"color":"nope"})).is_some());
        assert!(invalid("image.adjustments.gradientMap", &json!({"stops":[[0,"#000000"]]})).is_some());
        assert!(invalid("image.adjustments.gradientMap", &json!({"stops":[[0,"#000000"],[1,"#ffffff"]]})).is_none());
        assert!(invalid("image.adjustments.notOpen", &json!({})).is_some());
        assert!(invalid("edit.fade", &json!({"opacity":101})).is_some());
        assert!(invalid("edit.fade", &json!({"opacity":50,"mode":"Normal"})).is_none());
        assert!(invalid("image.adjustments.brightnessContrast", &json!({"brightness":35,"contrast":20,"legacy":false})).is_none());
        assert!(invalid("image.adjustments.brightnessContrast", &json!({"brightness":151})).is_some());
        assert!(invalid("image.adjustments.brightnessContrast", &json!({"legacy":1})).is_some());
        assert!(invalid("image.adjustments.curves", &json!({"points":[[0,0],[100,180],[255,255]]})).is_none());
        for points in [json!([[0,0]]),json!([[0,0],[0,255]]),json!([[0,0],[256,255]]),json!([[0,0],[0.1,255]])] {
            assert!(invalid("image.adjustments.curves", &json!({"points":points})).is_some());
        }
    }
}
