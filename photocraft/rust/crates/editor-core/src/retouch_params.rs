//! 润饰命令的严格参数校验。
//!
//! 固定引擎对部分参数做夹紧而不是拒绝（例如曝光度、容差），这在 UI 背后调用时会把明显无效的
//! 请求悄悄改成另一个结果。编辑器在写路由前复核公开范围与字段，越界或未知字段直接拒绝，保持
//! 「无效参数不写文档」的既有契约。

fn number(params: &serde_json::Value, key: &str) -> Option<f64> {
    params.get(key).and_then(serde_json::Value::as_f64)
}

fn in_range(params: &serde_json::Value, key: &str, min: f64, max: f64) -> bool {
    params.get(key).is_none_or(|value| value.as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max))
}

fn boolean(params: &serde_json::Value, key: &str) -> bool {
    params.get(key).is_none_or(|value| value.is_boolean())
}

fn points(params: &serde_json::Value) -> bool {
    params.get("points").is_none_or(|value| {
        value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 100_000
                && items.iter().all(|point| {
                    point.as_array().is_some_and(|pair| {
                        (pair.len() == 2 || pair.len() == 3)
                            && pair.get(0).is_some_and(|x| x.as_f64().is_some_and(f64::is_finite))
                            && pair.get(1).is_some_and(|y| y.as_f64().is_some_and(f64::is_finite))
                    })
                })
        })
    })
}

fn no_extra(params: &serde_json::Value, allowed: &[&str]) -> bool {
    params.as_object().is_some_and(|fields| fields.keys().all(|key| allowed.contains(&key.as_str())))
}

/// 返回拒绝原因；`None` 表示参数在公开范围内。
pub(crate) fn invalid(id: &str, params: &serde_json::Value) -> Option<String> {
    let bad = |message: &str| Some(format!("{message}（{id}）"));
    if !params.is_object() {
        return Some(format!("润饰参数必须为对象（{id}）"));
    }
    match id {
        "paint.redEye" => {
            if !no_extra(params, &["x", "y", "points", "pupilSize", "darken", "layer", "target", "channel"]) {
                return bad("红眼参数包含未知字段");
            }
            if params.get("points").is_none() && (number(params, "x").is_none() || number(params, "y").is_none()) {
                return bad("红眼需要 x/y 或 points");
            }
            if !in_range(params, "pupilSize", 1.0, 100.0) || !in_range(params, "darken", 0.0, 100.0) {
                return bad("瞳孔大小须为 1–100、变暗量须为 0–100");
            }
            None
        }
        "paint.magicEraser" => {
            if !no_extra(params, &["x", "y", "tolerance", "antiAlias", "contiguous", "sampleAllLayers", "opacity", "layer", "target", "channel"]) {
                return bad("魔术橡皮擦参数包含未知字段");
            }
            if number(params, "x").is_none() || number(params, "y").is_none() {
                return bad("魔术橡皮擦需要 x/y");
            }
            if !in_range(params, "tolerance", 0.0, 255.0) || !in_range(params, "opacity", 1.0, 100.0) {
                return bad("魔术橡皮擦容差须为 0–255、不透明度须为 1–100");
            }
            if !["antiAlias", "contiguous", "sampleAllLayers"].iter().all(|key| boolean(params, key)) {
                return bad("魔术橡皮擦布尔参数无效");
            }
            None
        }
        "paint.colorReplacement" | "paint.backgroundEraser" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if !in_range(params, "tolerance", 0.0, 100.0) || !in_range(params, "size", 1.0, 5000.0) {
                return bad("容差须为 0–100、笔尖须为 1–5000 px");
            }
            if !in_range(params, "hardness", 1.0, 100.0) || !in_range(params, "opacity", 1.0, 100.0) || !in_range(params, "flow", 1.0, 100.0) {
                return bad("硬度/不透明度/流量须为 1–100");
            }
            if !boolean(params, "antiAlias") || !boolean(params, "protectForegroundColor") {
                return bad("布尔参数无效");
            }
            if params.get("sampling").is_some_and(|value| !matches!(value.as_str(), Some("continuous" | "once" | "backgroundSwatch"))) {
                return bad("取样方式无效");
            }
            if params.get("limits").is_some_and(|value| !matches!(value.as_str(), Some("contiguous" | "discontiguous" | "findEdges"))) {
                return bad("范围限制无效");
            }
            if params.get("mode").is_some_and(|value| !matches!(value.as_str(), Some("hue" | "saturation" | "color" | "luminosity"))) {
                return bad("颜色替换模式无效");
            }
            None
        }
        "paint.dodge" | "paint.burn" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if !in_range(params, "exposure", 1.0, 100.0) || !in_range(params, "size", 1.0, 5000.0) {
                return bad("曝光度须为 1–100、笔尖须为 1–5000 px");
            }
            if params.get("range").is_some_and(|value| !matches!(value.as_str(), Some("shadows" | "midtones" | "highlights"))) {
                return bad("色调范围无效");
            }
            if !boolean(params, "protectTones") || !boolean(params, "sampleAllLayers") {
                return bad("布尔参数无效");
            }
            None
        }
        "paint.blur" | "paint.sharpen" | "paint.smudge" | "paint.spotHealing" | "paint.mixer" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if !in_range(params, "size", 1.0, 5000.0) || !in_range(params, "strength", 1.0, 100.0) {
                return bad("笔尖须为 1–5000 px、强度须为 1–100");
            }
            if !boolean(params, "protectDetail") || !boolean(params, "fingerPainting") || !boolean(params, "sampleAllLayers") {
                return bad("布尔参数无效");
            }
            if params.get("type").is_some_and(|value| !matches!(value.as_str(), Some("contentAware" | "createTexture" | "proximityMatch"))) {
                return bad("修复类型无效");
            }
            None
        }
        "paint.sponge" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if !in_range(params, "size", 1.0, 5000.0) {
                return bad("笔尖须为 1–5000 px");
            }
            if params.get("mode").is_some_and(|value| !matches!(value.as_str(), Some("desaturate" | "saturate"))) {
                return bad("海绵模式无效");
            }
            None
        }
        "paint.patternStamp" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if params.get("pattern").and_then(serde_json::Value::as_str).is_none_or(str::is_empty) {
                return bad("图案图章需要有效图案");
            }
            if !in_range(params, "scale", 1.0, 1000.0) {
                return bad("图案缩放须为 1–1000%");
            }
            None
        }
        "paint.historyBrush" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if let Some(state) = params.get("state") {
                if state.as_u64().is_none() {
                    return bad("历史状态须为非负整数");
                }
            }
            None
        }
        "paint.cloneStamp" | "paint.healingBrush" => {
            if !points(params) {
                return bad("笔画点位无效或为空");
            }
            if !in_range(params, "size", 1.0, 5000.0) {
                return bad("笔尖须为 1–5000 px");
            }
            if !boolean(params, "aligned") || !boolean(params, "wrap") {
                return bad("对齐/图案预览布尔参数无效");
            }
            if params.get("sampleLayer").is_some_and(|value| !matches!(value.as_str(), Some("current" | "currentAndBelow" | "all"))) {
                return bad("取样图层范围无效");
            }
            // 来源点与偏移必须成对出现且为有限坐标；交给内核前先拒绝半截参数。
            for key in ["source", "offset"] {
                if let Some(value) = params.get(key) {
                    let valid = value.as_array().is_some_and(|pair| pair.len() == 2 && pair.iter().all(|entry| entry.as_f64().is_some_and(f64::is_finite)));
                    if !valid {
                        return bad("克隆来源点或偏移必须是两个有限数值");
                    }
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_out_of_range_and_unknown_fields_before_writing() {
        assert!(invalid("paint.dodge", &json!({"points":[[1,1]],"exposure":0})).is_some());
        assert!(invalid("paint.dodge", &json!({"points":[[1,1]],"exposure":50})).is_none());
        assert!(invalid("paint.colorReplacement", &json!({"points":[],"tolerance":30})).is_some());
        assert!(invalid("paint.colorReplacement", &json!({"points":[[1,1]],"mode":"bogus"})).is_some());
        assert!(invalid("paint.colorReplacement", &json!({"points":[[1,"x"]]})).is_some());
        assert!(invalid("paint.redEye", &json!({"x":1,"y":2,"pupilSize":0})).is_some());
        assert!(invalid("paint.redEye", &json!({"x":1,"y":2})).is_none());
        assert!(invalid("paint.magicEraser", &json!({"x":1,"y":2,"tolerance":256})).is_some());
        assert!(invalid("paint.patternStamp", &json!({"points":[[1,1]],"pattern":""})).is_some());
        assert!(invalid("paint.historyBrush", &json!({"points":[[1,1]],"state":-1})).is_some());
    }

    #[test]
    fn clone_brushes_reject_half_params_and_out_of_range_sampling() {
        assert!(invalid("paint.cloneStamp", &json!({"points":[[1,1]]})).is_none());
        assert!(invalid("paint.healingBrush", &json!({"points":[[1,1]],"sampleLayer":"all"})).is_none());
        // 半截来源点、非有限坐标与未知取样范围都必须拒绝。
        assert!(invalid("paint.cloneStamp", &json!({"points":[[1,1]],"source":[10]})).is_some());
        assert!(invalid("paint.cloneStamp", &json!({"points":[[1,1]],"offset":["x",2]})).is_some());
        assert!(invalid("paint.healingBrush", &json!({"points":[[1,1]],"sampleLayer":"below"})).is_some());
        assert!(invalid("paint.cloneStamp", &json!({"points":[],"size":10})).is_some());
        assert!(invalid("paint.cloneStamp", &json!({"points":[[1,1]],"size":5001})).is_some());
        assert!(invalid("paint.cloneStamp", &json!({"points":[[1,1]],"aligned":"yes"})).is_some());
    }
}
