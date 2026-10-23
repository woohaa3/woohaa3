//! 结构型参数的有界校验：控制点、透视平面、位移点、光照列表与位移图来源。
//!
//! 这些字段是面板在图内拖出来的几何，不是滑杆：必须逐项检查有限数值、数量上限与拓扑
//! （单调位移点、凸四边形平面），否则内核会在后续步骤静默夹取或直接报一条用户看不懂的
//! 英文错误。所有错误都是本域稳定错误码 [`super::error::DRAFT`]。
//!
//! 本域**不接受本机路径**：位移图的 `mapPath` 一律拒绝，只允许 `mapDocument`/`mapLayer`
//! 指向已打开文档或图层（宿主保存与字节读取都在适配层，内核不碰路径）。

use serde_json::Value;

use super::catalog::{self, MAX_PINS, MAX_PLANES, MAX_RESOURCE_POINTS, bad};
use crate::Result;

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

fn point(value: &Value) -> Option<[f64; 2]> {
    let items = value.as_array()?;
    if items.len() < 2 {
        return None;
    }
    Some([finite(items.first()?)?, finite(items.get(1)?)?])
}

fn unit(value: f64) -> bool {
    (0.0..=1.0).contains(&value)
}

/// 是否有本机路径的形态（本域拒绝，避免内核持有宿主文件系统语义）。
fn looks_like_path(text: &str) -> bool {
    text.contains('/') || text.contains('\\') || text.starts_with("file:") || text.contains(":\\")
}

/// 位移图的位移点：`[[x,y], …]`，x 单调不减且都在 0–1，最多 64 点。
fn shear_points(value: &Value) -> Result<()> {
    let Some(items) = value.as_array() else {
        return Err(bad("切变曲线必须是 [[x,y], …] 数组"));
    };
    if items.is_empty() || items.len() > MAX_RESOURCE_POINTS {
        return Err(bad(format!("切变曲线需要 1–{MAX_RESOURCE_POINTS} 个点")));
    }
    let mut previous = f64::NEG_INFINITY;
    for (index, item) in items.iter().enumerate() {
        let [x, y] = point(item).ok_or_else(|| bad(format!("切变曲线第 {} 点必须是 [x,y]", index + 1)))?;
        if !unit(x) {
            return Err(bad("切变曲线的 x 必须在 0–1 之间"));
        }
        if x < previous {
            return Err(bad("切变曲线的 x 必须单调不减"));
        }
        if y.abs() > 10_000.0 {
            return Err(bad("切变曲线的 y 超出可用范围"));
        }
        previous = x;
    }
    Ok(())
}

/// 自定卷积核：25 个有限系数（-999–999），顺序为 5×5。
fn kernel(value: &Value) -> Result<()> {
    let items = value.as_array().ok_or_else(|| bad("自定卷积核必须是 25 个数值"))?;
    if items.len() != 25 {
        return Err(bad(format!("自定卷积核必须是 25 个数值（当前 {} 个）", items.len())));
    }
    for item in items {
        let Some(number) = finite(item) else {
            return Err(bad("自定卷积核的系数必须是有限数值"));
        };
        if !(-999.0..=999.0).contains(&number) {
            return Err(bad("自定卷积核的系数必须在 -999–999 之间"));
        }
    }
    Ok(())
}

/// 模糊画廊控制点/路径：数量上限 + 每个点的有限数值。
fn pins(value: &Value, label: &str) -> Result<()> {
    let Some(items) = value.as_array() else {
        return Err(bad(format!("{label}必须是数组")));
    };
    if items.len() > MAX_PINS {
        return Err(bad(format!("{label}最多 {MAX_PINS} 个")));
    }
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(bad(format!("{label}第 {} 项必须是对象", index + 1)));
        };
        for (key, value) in object {
            if key == "points" {
                let points = value.as_array().ok_or_else(|| bad("路径模糊的点必须是数组"))?;
                if points.len() > MAX_RESOURCE_POINTS {
                    return Err(bad(format!("路径模糊每条路径最多 {MAX_RESOURCE_POINTS} 个点")));
                }
                if points.iter().any(|point| self::point(point).is_none()) {
                    return Err(bad("路径模糊的点必须是 [x,y]"));
                }
                continue;
            }
            if finite(value).is_none() {
                return Err(bad(format!("{label}的 {key} 必须是有限数值")));
            }
        }
    }
    Ok(())
}

/// 一个绘制平面必须是凸四边形：任意顺序的四角不行，短于一个像素的边也不行。
///
/// 与内核 `VpPlane::check` 同判据（同号转角、边长 ≥ 1 像素）。这里先拒绝，用户看到的是
/// 本域的中文原因，而不是内核抛出的英文 `convex quad`；同时拦住「用 0–1 相对坐标当像素」
/// 这类把整张图画在亚像素上的输入（相对坐标的边必然短于 1 像素）。
fn quad(index: usize, corners: [[f64; 2]; 4]) -> Result<()> {
    let edge = |i: usize| [corners[(i + 1) % 4][0] - corners[i][0], corners[(i + 1) % 4][1] - corners[i][1]];
    let mut turn = 0.0f64;
    for i in 0..4 {
        let (a, b) = (edge(i), edge((i + 1) % 4));
        let (la, lb) = (a[0].hypot(a[1]), b[0].hypot(b[1]));
        if la < 1.0 || lb < 1.0 {
            return Err(bad(format!(
                "透视平面 {} 的角点必须用文档像素坐标，且相邻角点至少相距 1 像素",
                index + 1
            )));
        }
        let cross = (a[0] * b[1] - a[1] * b[0]) / (la * lb);
        if i == 0 {
            turn = cross;
        } else if cross.signum() != turn.signum() || cross.abs() < 1e-9 {
            return Err(bad(format!("透视平面 {} 的四个角点必须构成凸四边形", index + 1)));
        }
    }
    Ok(())
}

/// 消失点透视平面：最多 8 个，绘制面须为四个有限角点；撕出面须引用更早的平面。
fn planes(value: &Value) -> Result<()> {
    let Some(items) = value.as_array() else {
        return Err(bad("消失点需要 planes 数组"));
    };
    if items.is_empty() {
        return Err(bad("消失点至少需要一个透视平面"));
    }
    if items.len() > MAX_PLANES {
        return Err(bad(format!("消失点最多 {MAX_PLANES} 个透视平面")));
    }
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(bad(format!("透视平面 {} 必须是对象", index + 1)));
        };
        if let Some(corners) = object.get("corners") {
            let corners = corners.as_array().ok_or_else(|| bad("透视平面的 corners 必须是四个角点"))?;
            if corners.len() != 4 {
                return Err(bad("透视平面需要四个角点"));
            }
            let mut points = [[0.0f64; 2]; 4];
            for (corner, target) in corners.iter().zip(points.iter_mut()) {
                *target = point(corner).ok_or_else(|| bad("透视平面的角点必须是 [x,y]"))?;
            }
            quad(index, points)?;
            continue;
        }
        let from = object
            .get("from")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad(format!("透视平面 {} 需要 corners 或 from", index + 1)))?;
        if from as usize >= index {
            return Err(bad("撕出的平面只能引用更早的平面"));
        }
        if let Some(edge) = object.get("edge").and_then(Value::as_str)
            && !["top", "right", "bottom", "left"].contains(&edge)
        {
            return Err(bad("透视平面的 edge 必须是 top/right/bottom/left"));
        }
    }
    Ok(())
}

/// 消失点粘贴与克隆：目标平面索引、有限几何。
fn vanishing_extras(key: &str, value: &Value) -> Result<()> {
    let items = value.as_array().ok_or_else(|| bad(format!("{key} 必须是数组")))?;
    if items.len() > MAX_PINS {
        return Err(bad(format!("{key} 最多 {MAX_PINS} 项")));
    }
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(bad(format!("{key} 第 {} 项必须是对象", index + 1)));
        };
        if let Some(plane) = object.get("plane").and_then(Value::as_u64)
            && plane as usize >= MAX_PLANES
        {
            return Err(bad("粘贴引用的透视平面超出范围"));
        }
        if let Some(points) = object.get("points") {
            let points = points.as_array().ok_or_else(|| bad("克隆路径必须是点数组"))?;
            if points.len() > MAX_RESOURCE_POINTS {
                return Err(bad(format!("克隆路径最多 {MAX_RESOURCE_POINTS} 个点")));
            }
            if points.iter().any(|point| self::point(point).is_none()) {
                return Err(bad("克隆路径的点必须是 [x,y]"));
            }
        }
        if let Some(source) = object.get("source")
            && point(source).is_none()
        {
            return Err(bad("克隆的来源点必须是 [x,y]"));
        }
        if let Some(at) = object.get("at") {
            let at = point(at).ok_or_else(|| bad("粘贴位置必须是 [u,v]"))?;
            if !unit(at[0]) || !unit(at[1]) {
                return Err(bad("粘贴位置必须在 0–1 之间"));
            }
        }
        for (field, value) in object {
            // 点/数组型字段各自按几何校验过，其余必须是标量。
            if matches!(field.as_str(), "points" | "at" | "source" | "plane" | "layer") {
                continue;
            }
            if finite(value).is_none() {
                return Err(bad(format!("{key} 的 {field} 必须是有限数值")));
            }
        }
    }
    Ok(())
}

/// 自适应广角的约束线：端点有限、方向是已知选项。
fn constraints(value: &Value) -> Result<()> {
    let items = value.as_array().ok_or_else(|| bad("约束必须是数组"))?;
    if items.len() > MAX_RESOURCE_POINTS {
        return Err(bad(format!("约束最多 {MAX_RESOURCE_POINTS} 条")));
    }
    for (index, item) in items.iter().enumerate() {
        let object = item.as_object().ok_or_else(|| bad(format!("约束 {} 必须是对象", index + 1)))?;
        for end in ["a", "b"] {
            let end = object.get(end).ok_or_else(|| bad("约束需要 a 与 b 两个端点"))?;
            if point(end).is_none() {
                return Err(bad("约束端点必须是 [x,y]"));
            }
        }
        if let Some(orientation) = object.get("orientation").and_then(Value::as_str)
            && !["free", "horizontal", "vertical"].contains(&orientation)
        {
            return Err(bad("约束方向必须是 free/horizontal/vertical"));
        }
    }
    Ok(())
}

/// 光照效果的光源列表：最多 16 盏，字段有限。
fn lights(value: &Value) -> Result<()> {
    let items = value.as_array().ok_or_else(|| bad("光源必须是数组"))?;
    if items.len() > MAX_PINS {
        return Err(bad(format!("光源最多 {MAX_PINS} 盏")));
    }
    for item in items {
        let object = item.as_object().ok_or_else(|| bad("光源必须是对象"))?;
        for (field, value) in object {
            match value {
                Value::String(name) => {
                    if field == "kind" && !["spot", "point", "infinite"].contains(&name.as_str()) {
                        return Err(bad("光源类型必须是 spot/point/infinite"));
                    }
                }
                Value::Array(colour) => {
                    let _ = colour;
                }
                other => {
                    if finite(other).is_none() {
                        return Err(bad(format!("光源的 {field} 必须是有限数值")));
                    }
                }
            }
        }
    }
    Ok(())
}

/// 颜色型 `json` 参数（前景/背景/发光色）：接受 `#rrggbb` 或 `[r,g,b(,a)]`。
fn colour(value: &Value) -> Result<()> {
    match value {
        Value::String(text)
            if text.len() == 7
                && text.starts_with('#')
                && text[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            Ok(())
        }
        Value::Array(items) if (3..=4).contains(&items.len()) && items.iter().all(|item| finite(item).is_some()) => Ok(()),
        _ => Err(bad("颜色必须是 #rrggbb 或 [r,g,b]")),
    }
}

/// 通用有界结构：拒绝路径、超量条目与嵌套过深的资源。
fn bounded(value: &Value, depth: usize) -> Result<()> {
    if depth > 4 {
        return Err(bad("结构参数嵌套过深"));
    }
    match value {
        Value::Null => Ok(()),
        Value::Bool(_) => Ok(()),
        Value::Number(_) if finite(value).is_some() => Ok(()),
        Value::Number(_) => Err(bad("数值必须是有限数")),
        Value::String(text) => {
            if text.len() > 200 {
                return Err(bad("文本参数过长"));
            }
            if looks_like_path(text) {
                return Err(bad("本应用不允许按本机路径读取滤镜资源"));
            }
            Ok(())
        }
        Value::Array(items) => {
            if items.len() > MAX_RESOURCE_POINTS {
                return Err(bad(format!("结构参数最多 {MAX_RESOURCE_POINTS} 项")));
            }
            items.iter().try_for_each(|item| bounded(item, depth + 1))
        }
        Value::Object(object) => {
            if object.len() > MAX_RESOURCE_POINTS {
                return Err(bad(format!("结构参数最多 {MAX_RESOURCE_POINTS} 个字段")));
            }
            object.values().try_for_each(|item| bounded(item, depth + 1))
        }
    }
}

/// 逐命令校验一个结构型参数。
pub(super) fn validate_resource(entry: &catalog::Entry, key: &str, value: &Value) -> Result<()> {
    match (entry.id, key) {
        ("filter.other.custom", "kernel") => return kernel(value),
        ("filter.distort.shear", "points") => return shear_points(value),
        ("filter.adaptiveWideAngle", "constraints") => return constraints(value),
        ("filter.vanishingPoint", "planes") => return planes(value),
        ("filter.vanishingPoint", "paste" | "clone") => return vanishing_extras(key, value),
        ("filter.render.lightingEffects", "lights") => return lights(value),
        _ => {}
    }
    if key.starts_with("map") {
        // 位移图来源：只接受文档/图层引用，拒绝本机路径。
        return match key {
            "mapPath" => Err(bad("本应用不允许按本机路径读取位移图，请改用位移图文档或图层")),
            "mapLayer" => match value.as_u64() {
                Some(_) => Ok(()),
                None => Err(bad("位移图图层必须是图层 id")),
            },
            "mapDocument" => match value {
                Value::String(name) if !name.is_empty() && name.len() <= 200 && !looks_like_path(name) => Ok(()),
                Value::Number(_) if value.as_u64().is_some() => Ok(()),
                _ => Err(bad("位移图文档必须是文档名或序号")),
            },
            _ => bounded(value, 0),
        };
    }
    if entry.id.starts_with("filter.blurGallery.") && matches!(key, "pins" | "paths") {
        return pins(value, if key == "pins" { "控制点" } else { "路径" });
    }
    if matches!(key, "foreground" | "background" | "color" | "glowColor" | "vineColor" | "flowerColor" | "leafColor" | "leavesColor" | "branchesColor") {
        return colour(value);
    }
    bounded(value, 0)
}

/// 模糊画廊的图内几何：必须有有限控制几何，且范围与内核一致。
pub(super) fn validate_blur_gallery(id: &str, params: &Value) -> Result<()> {
    let number = |key: &str| params.get(key).and_then(finite);
    match id {
        "filter.blurGallery.tiltShift" => {
            for key in ["centerX", "centerY"] {
                if let Some(value) = number(key)
                    && !unit(value)
                {
                    return Err(bad(format!("{key} 必须在 0–1 之间")));
                }
            }
        }
        "filter.blurGallery.irisBlur" | "filter.blurGallery.spinBlur" => {
            if params.get("pins").is_none() {
                for key in ["centerX", "centerY"] {
                    if let Some(value) = number(key)
                        && !unit(value)
                    {
                        return Err(bad(format!("{key} 必须在 0–1 之间")));
                    }
                }
                for key in ["radiusX", "radiusY"] {
                    if let Some(value) = number(key)
                        && !(0.001..=1.0).contains(&value)
                    {
                        return Err(bad(format!("{key} 必须在 0.001–1 之间")));
                    }
                }
            }
        }
        "filter.blurGallery.fieldBlur" => {
            if params.get("pins").is_none() {
                for key in ["centerX", "centerY"] {
                    if let Some(value) = number(key)
                        && !unit(value)
                    {
                        return Err(bad(format!("{key} 必须在 0–1 之间")));
                    }
                }
            }
        }
        "filter.blurGallery.pathBlur" => {
            if params.get("paths").is_none() {
                for key in ["startX", "startY", "endX", "endY"] {
                    if let Some(value) = number(key)
                        && !unit(value)
                    {
                        return Err(bad(format!("{key} 必须在 0–1 之间")));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// 消失点的必需几何与附加结构。
pub(super) fn validate_vanishing_point(params: &Value) -> Result<()> {
    let planes_value = params.get("planes").ok_or_else(|| bad("消失点至少需要一个透视平面"))?;
    planes(planes_value)?;
    for key in ["paste", "clone"] {
        if let Some(value) = params.get(key) {
            vanishing_extras(key, value)?;
        }
    }
    Ok(())
}

/// 图内控制点的规范化：把面板的文档坐标换算成内核的 0–1 相对坐标，并夹在范围内。
pub fn normalize_point(x: f64, y: f64, width: f64, height: f64) -> Result<[f64; 2]> {
    if !x.is_finite() || !y.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(bad("控制点坐标无效"));
    }
    Ok([(x / width).clamp(0.0, 1.0), (y / height).clamp(0.0, 1.0)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str) -> &'static catalog::Entry {
        catalog::entry(id).expect("entry")
    }

    #[test]
    fn shear_points_must_be_bounded_and_monotonic() {
        assert!(validate_resource(entry("filter.distort.shear"), "points", &json!([[0, 0], [1, 0]])).is_ok());
        assert!(validate_resource(entry("filter.distort.shear"), "points", &json!([[0.5, 0], [0.4, 0]])).is_err());
        assert!(validate_resource(entry("filter.distort.shear"), "points", &json!([[2, 0]])).is_err());
        assert!(validate_resource(entry("filter.distort.shear"), "points", &json!([])).is_err());
    }

    #[test]
    fn custom_kernel_needs_twenty_five_finite_coefficients() {
        let mut kernel = vec![json!(0); 25];
        assert!(validate_resource(entry("filter.other.custom"), "kernel", &Value::Array(kernel.clone())).is_ok());
        kernel[4] = json!("x");
        assert!(validate_resource(entry("filter.other.custom"), "kernel", &Value::Array(kernel)).is_err());
        assert!(validate_resource(entry("filter.other.custom"), "kernel", &json!([1, 2, 3])).is_err());
    }

    #[test]
    fn displacement_maps_never_come_from_a_local_path() {
        assert!(validate_resource(entry("filter.distort.displace"), "mapPath", &json!("/tmp/map.png")).is_err());
        assert!(validate_resource(entry("filter.distort.displace"), "mapDocument", &json!("/tmp/map.psd")).is_err());
        assert!(validate_resource(entry("filter.distort.displace"), "mapDocument", &json!("map.pcraft")).is_ok());
        assert!(validate_resource(entry("filter.distort.displace"), "mapLayer", &json!(7)).is_ok());
        assert!(validate_resource(entry("filter.distort.displace"), "mapLayer", &json!("7")).is_err());
    }

    #[test]
    fn vanishing_point_planes_are_bounded_and_tear_offs_reference_earlier_planes() {
        let square = json!([{"corners": [[20, 20], [180, 20], [180, 180], [20, 180]]}]);
        assert!(validate_vanishing_point(&json!({"planes": square})).is_ok());
        assert!(validate_vanishing_point(&json!({"planes": [{"from": 0, "edge": "top"}]})).is_err());
        assert!(validate_vanishing_point(&json!({"planes": [{"corners": [[0, 0], [1, 1], [2, 2]]}]})).is_err());
        let too_many: Vec<Value> = (0..9).map(|_| square[0].clone()).collect();
        assert!(validate_vanishing_point(&json!({"planes": too_many})).is_err());
        assert!(validate_vanishing_point(&json!({})).is_err());
    }

    #[test]
    fn colours_and_light_lists_are_checked() {
        assert!(validate_resource(entry("filter.render.fibers"), "foreground", &json!("#3366cc")).is_ok());
        assert!(validate_resource(entry("filter.render.fibers"), "foreground", &json!("blue")).is_err());
        assert!(validate_resource(entry("filter.render.lightingEffects"), "lights", &json!([{"x": 1, "y": 2, "kind": "spot"}])).is_ok());
        assert!(validate_resource(entry("filter.render.lightingEffects"), "lights", &json!([{"kind": "laser"}])).is_err());
    }

    #[test]
    fn resource_strings_cannot_smuggle_paths() {
        assert!(bounded(&json!({"name": "C:\\photos\\map.png"}), 0).is_err());
        assert!(bounded(&json!({"name": "工作路径"}), 0).is_ok());
    }

    #[test]
    fn normalized_control_points_are_relative_and_clamped() {
        assert_eq!(normalize_point(50.0, 25.0, 100.0, 100.0).unwrap(), [0.5, 0.25]);
        assert_eq!(normalize_point(-10.0, 400.0, 100.0, 100.0).unwrap(), [0.0, 1.0]);
        assert!(normalize_point(f64::NAN, 0.0, 100.0, 100.0).is_err());
    }

    #[test]
    fn vanishing_planes_need_pixel_sized_convex_quads() {
        let convex = json!([{"corners": [[120, 120], [280, 120], [360, 280], [40, 280]]}]);
        assert!(planes(&convex).is_ok());
        // 0–1 相对坐标的边短于一个像素：那不是文档像素平面。
        let relative = json!([{"corners": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]}]);
        assert!(planes(&relative).is_err(), "相对坐标平面必须拒绝");
        let bow_tie = json!([{"corners": [[0, 0], [100, 100], [100, 0], [0, 100]]}]);
        assert!(planes(&bow_tie).is_err(), "自交四边形没有透视");
        let dented = json!([{"corners": [[0, 0], [200, 0], [100, 40], [0, 200]]}]);
        assert!(planes(&dented).is_err(), "凹四边形没有透视");
        // 撕出面仍只校验引用顺序。
        assert!(planes(&json!([{"corners": [[0, 0], [200, 0], [200, 200], [0, 200]]}, {"from": 0, "edge": "top"}])).is_ok());
        assert!(planes(&json!([{"from": 0}])).is_err());
    }
}
