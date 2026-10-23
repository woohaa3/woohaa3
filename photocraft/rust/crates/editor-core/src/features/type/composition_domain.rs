use super::*;

/// 当前开放的文字排版参数（其余参数明确拒绝，不只隐藏控件）。
///
/// 这一份是字符层（`CharStyle`）参数；段落层参数与它们同属 `type.setStyle`，见
/// [`PARAGRAPH_PARAMS`]。两组都必须在这里登记，否则界面会拿到「尚未开放」的错误。
pub const TYPOGRAPHY_PARAMS: &[&str] = &[
    "leading",
    "leadingBy",
    "tracking",
    "trackingBy",
    "kerning",
    "kernPair",
    "baselineShift",
    "baselineShiftBy",
];

/// 段落选项：与上游 `apply_para_props` 的键一一对应（全部已实现，不再有占位项）。
pub const PARAGRAPH_PARAMS: &[&str] = &[
    "align",
    "firstLineIndent",
    "startIndent",
    "endIndent",
    "spaceBefore",
    "spaceAfter",
    "autoLeading",
    "direction",
    "hyphenate",
];

/// 段落对齐值：与内核 `TextAlign` 的渲染名一致（`justifyLeft` 也接受，等同 `justify`）。
pub const PARAGRAPH_ALIGNS: &[&str] = &[
    "left",
    "center",
    "right",
    "justify",
    "justifyLeft",
    "justifyCenter",
    "justifyRight",
    "justifyAll",
];

const PARAGRAPH_FIELDS: &[&str] = &["firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter", "autoLeading"];

fn paragraph(value: &Value) -> std::result::Result<(), String> {
    if let Some(align) = value.get("align") {
        let valid = align.as_str().is_some_and(|align| PARAGRAPH_ALIGNS.contains(&align));
        if !valid {
            return Err(format!("align 必须是 {}", PARAGRAPH_ALIGNS.join("/")));
        }
    }
    for key in PARAGRAPH_FIELDS {
        if let Some(field) = value.get(key) {
            // 缩进/间距是 pt（±5000），`autoLeading` 是百分比（0–1000，内核再除以 100）。
            let limit = if *key == "autoLeading" { 1000.0 } else { 5000.0 };
            let number = field.as_f64().filter(|number| number.is_finite() && number.abs() <= limit);
            if number.is_none() {
                return Err(format!("{key} 必须是 ±{limit} 内的有限数值"));
            }
        }
    }
    if let Some(direction) = value.get("direction") {
        let valid = direction.as_str().is_some_and(|direction| matches!(direction, "auto" | "ltr" | "rtl"));
        if !valid {
            return Err("direction 必须是 auto/ltr/rtl".into());
        }
    }
    match value.get("hyphenate") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(_)) => {}
        Some(_) => return Err("hyphenate 必须是布尔值".into()),
    }
    Ok(())
}

/// 校验并编译文字排版参数（失败时不调用内核，也不改草稿）。
///
/// 返回的补丁**可能同时包含**要发给 `type.edit` 的键：`kernPair` 是上游 `type.edit` 的参数
/// （它按「光标前一对字符」计算现有字距再叠加），`type.setStyle` 会**静默忽略**它。
/// 因此这里把它拆到一个独立的 `edit` 字段里，由调用方发给正确的命令，
/// 而不是发出去被吞掉再报「成功」。
pub fn typography_patch(params: &Value) -> Result<Value> {
    let object = params
        .as_object()
        .ok_or_else(|| error("type.setStyle", "排版参数必须是对象"))?;
    if object.is_empty() {
        return Err(error("type.setStyle", "排版参数不能为空"));
    }
    let mut patch = serde_json::Map::new();
    let mut edit = serde_json::Map::new();
    for (key, value) in object {
        if PARAGRAPH_PARAMS.contains(&key.as_str()) {
            patch.insert(key.clone(), value.clone());
            continue;
        }
        if !TYPOGRAPHY_PARAMS.contains(&key.as_str()) {
            return Err(error("type.setStyle", format!("排版参数 {key} 尚未开放")));
        }
        match key.as_str() {
            "leading" | "leadingBy" | "baselineShift" | "baselineShiftBy" => {
                let number = value.as_f64().filter(|value| value.is_finite() && value.abs() <= 5000.0);
                if number.is_none() {
                    return Err(error("type.setStyle", format!("{key} 必须是 ±5000 内的有限数值")));
                }
                patch.insert(key.clone(), value.clone());
            }
            "tracking" | "trackingBy" => {
                let number = value.as_f64().filter(|value| value.is_finite() && (-1000.0..=10000.0).contains(value));
                if number.is_none() {
                    return Err(error("type.setStyle", format!("{key} 必须在 -1000–10000（1/1000 em）")));
                }
                patch.insert(key.clone(), value.clone());
            }
            "kerning" => {
                let valid = match value {
                    Value::String(mode) => matches!(mode.as_str(), "metrics" | "optical" | "off"),
                    Value::Number(_) => value.as_f64().is_some_and(|number| number.is_finite() && number.abs() <= 1000.0),
                    _ => false,
                };
                if !valid {
                    return Err(error("type.setStyle", "kerning 必须是 metrics/optical/off 或 ±1000 内的数值"));
                }
                patch.insert(key.clone(), value.clone());
            }
            "kernPair" => {
                let valid = value
                    .as_object()
                    .and_then(|pair| {
                        let at = pair.get("at")?.as_u64()?;
                        let by = pair.get("by")?.as_f64()?;
                        (by.is_finite() && by.abs() <= 1000.0).then_some(at)
                    })
                    .is_some();
                if !valid {
                    return Err(error("type.setStyle", "kernPair 需要 {at, by}（by 为 ±1000 的 1/1000 em）"));
                }
                // `at` 是光标位置（第几个字符之间），必须夹在首尾之间才有「一对字符」。
                let at = value["at"].as_u64().unwrap_or(0);
                if at == 0 {
                    return Err(error("type.setStyle", "kernPair.at 必须是两个字符之间的光标位置（从 1 起）"));
                }
                edit.insert(key.clone(), value.clone());
            }
            _ => {}
        }
    }
    // 段落键统一在这里校验：它们在 `patch` 里原样透传，校验失败时不产生任何内核调用。
    paragraph(&Value::Object(patch.clone())).map_err(|message| error("type.setStyle", message))?;
    let mut out = patch;
    if !edit.is_empty() {
        out.insert("edit".into(), Value::Object(edit));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_and_paragraph_params_are_both_open() {
        let patch = typography_patch(&json!({"leading": 24, "kerning": "optical", "align": "justifyAll", "spaceBefore": 6}))
            .expect("character and paragraph keys are both accepted");
        assert_eq!(patch["align"], "justifyAll");
        assert_eq!(patch["spaceBefore"], 6.0);
    }

    #[test]
    fn paragraph_keys_are_validated_before_the_kernel() {
        for bad in [
            json!({"align": "middle"}),
            json!({"firstLineIndent": 1e9}),
            json!({"autoLeading": 5000}),
            json!({"direction": "diagonal"}),
            json!({"hyphenate": 1}),
            json!({"spaceAfter": "6"}),
        ] {
            assert!(typography_patch(&bad).is_err(), "{bad}");
        }
        assert!(typography_patch(&json!({"autoLeading": 120})).is_ok());
        assert!(typography_patch(&json!({"direction": "rtl", "hyphenate": true})).is_ok());
    }

    #[test]
    fn unopened_params_stay_closed() {
        assert!(typography_patch(&json!({"vertical": true})).is_err());
        assert!(typography_patch(&json!({"warp": "arc"})).is_err());
        assert!(typography_patch(&json!({})).is_err());
    }
}
