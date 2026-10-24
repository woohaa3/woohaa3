//! 画笔设置写入前的严格校验（I132）。
//!
//! 固定引擎对多数画笔字段做**夹紧**而不是拒绝（`spacing`、`angle`、`roundness` 等）。界面背后
//! 调用时这会把明显无效的输入悄悄改成另一个结果。编辑器在写路由前复核公开范围、未知字段与
//! 布尔/枚举类型，保持「无效参数不写文档/工具状态」的既有契约。

use serde_json::Value;

/// 面板可提交的字段（与 `brush-settings-panel.tsx` 的补丁同构）。
const SCALARS: &[(&str, f64, f64)] = &[
    ("spacing", 0.01, 10.0),
    ("angle", -180.0, 180.0),
    ("roundness", 0.0, 1.0),
    ("buildUpRate", 0.1, 120.0),
    ("size", 0.5, 5000.0),
    ("hardness", 0.0, 1.0),
    ("opacity", 0.0, 1.0),
    ("flow", 0.0, 1.0),
];
const FLAGS: &[&str] = &[
    "spacingEnabled", "pressureSize", "pressureOpacity", "flipX", "flipY", "noise", "wetEdges", "buildUp",
];
const SECTIONS: &[&str] = &["shapeDynamics", "scattering", "transfer"];

fn bad(message: impl std::fmt::Display) -> String {
    format!("画笔设置无效：{message}")
}

/// 严格检查动态分区：`enabled` 必须是布尔，抖动/最小值必须是 0–1 的数值（或 0–10 的散布）。
fn check_section(name: &str, value: &Value) -> Result<(), String> {
    let fields = value.as_object().ok_or_else(|| bad(format!("{name} 必须是对象")))?;
    if let Some(enabled) = fields.get("enabled")
        && !enabled.is_boolean()
    {
        return Err(bad(format!("{name}.enabled 必须是布尔值")));
    }
    if let Some(axes) = fields.get("bothAxes")
        && !axes.is_boolean()
    {
        return Err(bad(format!("{name}.bothAxes 必须是布尔值")));
    }
    for (key, entry) in fields {
        if matches!(key.as_str(), "enabled" | "bothAxes") {
            continue;
        }
        // 散布用 0–10（1000%），其余动态用 0–1。
        let upper = if name == "scattering" && key == "scatter" { 10.0 } else { 1.0 };
        let dynamic = entry
            .as_object()
            .ok_or_else(|| bad(format!("{name}.{key} 必须是含 jitter/minimum 的对象")))?;
        for (field, raw) in dynamic {
            if !matches!(field.as_str(), "jitter" | "minimum") {
                return Err(bad(format!("{name}.{key} 含未知字段 {field}")));
            }
            match raw.as_f64() {
                Some(number) if number.is_finite() && number >= 0.0 && number <= upper => {}
                _ => return Err(bad(format!("{name}.{key}.{field} 必须在 0–{upper} 之间"))),
            }
        }
    }
    Ok(())
}

/// 返回拒绝原因；`None` 表示参数在公开范围内。
pub(super) fn invalid(params: &Value) -> Option<String> {
    let fields = params.as_object()?;
    if fields.is_empty() {
        return Some(bad("至少需要一个字段"));
    }
    for (key, value) in fields {
        let name = key.as_str();
        if let Some((_, min, max)) = SCALARS.iter().find(|(id, _, _)| *id == name) {
            match value.as_f64() {
                Some(number) if number.is_finite() && number >= *min && number <= *max => {}
                _ => return Some(bad(format!("{name} 必须在 {min}–{max} 之间"))),
            }
            continue;
        }
        if FLAGS.contains(&name) {
            if !value.is_boolean() {
                return Some(bad(format!("{name} 必须是布尔值")));
            }
            continue;
        }
        if SECTIONS.contains(&name) {
            if let Err(message) = check_section(name, value) {
                return Some(message);
            }
            continue;
        }
        return Some(bad(format!("未开放的画笔字段 {name}")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_the_panel_patch_and_rejects_out_of_range_values() {
        assert!(invalid(&json!({
            "spacing":0.4,"angle":30,"roundness":0.6,"pressureSize":true,"noise":false,
            "shapeDynamics":{"enabled":true,"size":{"jitter":0.5,"minimum":0.2}},
            "scattering":{"enabled":true,"scatter":{"jitter":1.5},"bothAxes":true},
            "transfer":{"enabled":true,"opacity":{"jitter":0.3}}
        })).is_none());
        for bad_request in [
            json!({"spacing":0}), json!({"spacing":11}), json!({"angle":400}), json!({"roundness":2}),
            json!({"pressureSize":"yes"}), json!({"unknownField":1}), json!({}),
            json!({"shapeDynamics":{"enabled":"yes"}}),
            json!({"shapeDynamics":{"size":{"jitter":2}}}),
            json!({"scattering":{"scatter":{"jitter":11}}}),
            json!({"transfer":{"opacity":{"unknown":1}}}),
            json!({"buildUpRate":0}),
        ] {
            assert!(invalid(&bad_request).is_some(), "必须拒绝：{bad_request}");
        }
    }
}
