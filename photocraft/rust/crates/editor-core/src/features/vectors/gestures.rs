//! 画布手势 → 规范形状参数的唯一换算（U08/U09/U16，change:
//! 2026-10-22-add-photocraft-vector-canvas-tools，design D1/D2）。
//!
//! 这一层只做纯计算，不碰文档、不碰历史：拖绘预览画什么、松手提交什么，都由这里决定。
//! 前端叠加层用同一份结果画预览，提交时把同一个 JSON 交给 `shape.create` /
//! `shape.presets.place`，因此「图内拖出的形状」和「面板数值创建」共享几何，不存在第二套。
//!
//! 三条规则来自设计：
//!
//! 1. 源像素坐标，不做任何屏幕坐标换算（取景换算在共享 Canvas 端口完成）；
//! 2. Shift 约束比例/角度、Alt 从中心、零面积与超限几何直接拒绝（不提交半成品）；
//! 3. 形状参数按上游 `shape.create` 的参数名与范围生成，编号与取值范围在这里收口，
//!    非法边数/星形比例/圆角不会被静默夹到合法值以外。

use serde_json::{Value, json};

use crate::error::{EditorError, Result};

/// 一个形状工具可拖绘的形状种类（与工具栏子工具一一对应）。
pub const DRAW_KINDS: &[&str] = &["rect", "roundedRect", "ellipse", "triangle", "polygon", "star", "line"];

/// 拖绘手势的修饰键（只保留本域用到的两个）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShapeModifiers {
    /// 约束比例（矩形/椭圆/多边形）或 45° 角度（直线）。
    pub constrain: bool,
    /// 从起点作为中心向外拖绘。
    pub from_center: bool,
}

/// 拖绘参数：`kind` 是形状种类，两个点是屏幕换算后的源坐标。
#[derive(Clone, Debug)]
pub struct DrawInput {
    pub kind: String,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub modifiers: ShapeModifiers,
    /// 圆角半径（roundedRect / rect），四角相同。
    pub radius: f64,
    /// 多边形与星形的边数。
    pub sides: u32,
    /// 星形内外半径比。
    pub star_ratio: f64,
    /// 直线的粗细。
    pub weight: f64,
}

/// 规范化后的形状几何（源像素坐标），`rect` 已翻正。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapeGeometry {
    pub rect: [f64; 4],
    /// 直线专用的两个端点（其余形状等于 `rect` 的两角）。
    pub from: [f64; 2],
    pub to: [f64; 2],
}

fn bad(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "vector.shape.gesture".into(), message: message.to_string() }
}

/// 画布坐标是否可提交（有限、非 NaN、在画布放宽范围内）。
pub fn point_in_canvas(point: [f64; 2], canvas: [u32; 2]) -> bool {
    let limit = |side: u32| f64::from(side.max(1)) * 8.0;
    point.iter().all(|v| v.is_finite() && v.abs() <= limit(canvas[0]).max(limit(canvas[1])))
}

/// 有限数值的范围校验（复用同一条错误文案，避免各处口径不同）。
fn bounded(value: f64, low: f64, high: f64, name: &str) -> Result<f64> {
    if !value.is_finite() || value < low || value > high {
        return Err(bad(format!("{name} 必须在 {low}–{high} 之间")));
    }
    Ok(value)
}

/// 由拖绘起止点与修饰键计算规范几何。
///
/// 零面积（拖动距离为 0）返回错误，调用方据此取消而不提交；这也是「单击创建尺寸对话框」
/// 的分支点：界面在收到零面积时改为打开尺寸输入，而不是创建一个看不见的形状。
pub fn shape_geometry(input: &DrawInput, canvas: [u32; 2]) -> Result<ShapeGeometry> {
    let [sx, sy] = input.start;
    let [mut ex, mut ey] = input.end;
    if !point_in_canvas(input.start, canvas) || !point_in_canvas(input.end, canvas) {
        return Err(bad("形状起点或终点超出文档可保存范围"));
    }
    let line = input.kind == "line";
    if input.modifiers.constrain {
        if line {
            // 直线约束到 15° 的整数倍角度（与上游 Shift 直线一致）。
            let dx = ex - sx;
            let dy = ey - sy;
            let length = dx.hypot(dy);
            if length > 0.0 {
                let step = std::f64::consts::PI / 12.0;
                let angle = (dy.atan2(dx) / step).round() * step;
                ex = sx + length * angle.cos();
                ey = sy + length * angle.sin();
            }
        } else {
            // 比例约束：以较小边为准的正方形（从中心时向两侧等量扩展）。
            let dx = ex - sx;
            let dy = ey - sy;
            let side = dx.abs().max(dy.abs());
            ex = sx + side * if dx < 0.0 { -1.0 } else { 1.0 };
            ey = sy + side * if dy < 0.0 { -1.0 } else { 1.0 };
        }
    }
    let (x0, y0, x1, y1) = if input.modifiers.from_center {
        let dx = (ex - sx).abs();
        let dy = (ey - sy).abs();
        (sx - dx, sy - dy, sx + dx, sy + dy)
    } else {
        (sx.min(ex), sy.min(ey), sx.max(ex), sy.max(ey))
    };
    let width = x1 - x0;
    let height = y1 - y0;
    if line {
        // 直线允许任意方向，只有长度为 0 才拒绝。
        if (ex - sx).hypot(ey - sy) < 1e-6 {
            return Err(bad("直线长度为零"));
        }
    } else if width < 1e-6 || height < 1e-6 {
        return Err(bad("形状面积为零，请拖出更大的范围或改用尺寸输入"));
    }
    Ok(ShapeGeometry { rect: [x0, y0, width, height], from: [sx, sy], to: [ex, ey] })
}

/// 由拖绘输入计算 `shape.create` 参数（拖绘预览与松手提交共用这一份结果）。
pub fn shape_create_params(input: &DrawInput, canvas: [u32; 2]) -> Result<Value> {
    let geometry = shape_geometry(input, canvas)?;
    build_shape_params(&input.kind, geometry, input)
}

/// 解析来自前端的拖绘参数（JSON）：字段与 `DrawInput` 一一对应，缺失用安全默认值。
///
/// 数值仍要过 `shape_geometry` / `build_shape_params` 的范围裁定，因此这里只做类型解析，
/// 不重复范围检查，也不接受未知形状种类。
pub fn parse_draw_input(value: &Value) -> Result<DrawInput> {
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| DRAW_KINDS.contains(kind))
        .ok_or_else(|| bad("缺少或未知的形状种类"))?
        .to_string();
    let pair = |key: &str| -> Result<[f64; 2]> {
        let list = value
            .get(key)
            .and_then(Value::as_array)
            .filter(|list| list.len() == 2)
            .ok_or_else(|| bad(format!("`{key}` 必须是 [x, y]")))?;
        let x = list[0].as_f64().ok_or_else(|| bad(format!("`{key}` 必须是数值")))?;
        let y = list[1].as_f64().ok_or_else(|| bad(format!("`{key}` 必须是数值")))?;
        Ok([x, y])
    };
    let number = |key: &str, fallback: f64| value.get(key).and_then(Value::as_f64).unwrap_or(fallback);
    let sides = value.get("sides").and_then(Value::as_u64).unwrap_or(5);
    let sides = u32::try_from(sides).map_err(|_| bad("边数超出范围"))?;
    Ok(DrawInput {
        kind,
        start: pair("start")?,
        end: pair("end")?,
        modifiers: ShapeModifiers {
            constrain: value.get("constrain").and_then(Value::as_bool).unwrap_or(false),
            from_center: value.get("fromCenter").and_then(Value::as_bool).unwrap_or(false),
        },
        radius: number("radius", 0.0),
        sides,
        star_ratio: number("starRatio", 0.5),
        weight: number("weight", 1.0),
    })
}

/// 由已确定的几何编译 `shape.create` 参数：面板数值创建与拖绘共用同一条路径。
pub fn build_shape_params(kind: &str, geometry: ShapeGeometry, input: &DrawInput) -> Result<Value> {
    if !DRAW_KINDS.contains(&kind) {
        return Err(bad(format!("{kind} 不是可拖绘的形状种类")));
    }
    for value in geometry.rect.iter().chain(geometry.from.iter()).chain(geometry.to.iter()) {
        if !value.is_finite() {
            return Err(bad("形状几何必须是有限数值"));
        }
    }
    let [x, y, width, height] = geometry.rect;
    let mut params = json!({ "kind": kind, "rect": [x, y, width, height] });
    if kind == "line" {
        let weight = bounded(input.weight, 0.0, 1_000_000.0, "线宽")?;
        params = json!({
            "kind": "line",
            "from": geometry.from,
            "to": geometry.to,
            "weight": weight,
        });
        return Ok(params);
    }
    let radius = bounded(input.radius, 0.0, width.min(height) / 2.0, "圆角半径")?;
    match kind {
        "rect" | "roundedRect" => {
            // 圆角矩形要求正半径，矩形显式给 0 保持一致的可重编参数。
            let radii = if kind == "roundedRect" && radius <= 0.0 { 10.0_f64.min(width.min(height) / 2.0) } else { radius };
            params["radii"] = json!([radii, radii, radii, radii]);
        }
        "ellipse" => {}
        "triangle" | "polygon" | "star" => {
            let sides = if kind == "triangle" { 3 } else { input.sides };
            if !(3..=100).contains(&sides) {
                return Err(bad("多边形的边数必须在 3–100 之间"));
            }
            // 上游没有 `triangle` 这个 kind：三角形就是三边正多边形。这里把界面种类
            // 归一到内核真正认识的 `polygon`，避免出现「面板可选、内核不认」的悬空种类。
            if kind == "triangle" {
                params["kind"] = json!("polygon");
            }
            params["sides"] = json!(sides);
            // 只有星形才发 `starRatio`：上游把 `star_ratio == 1.0` 当作「正多边形」的哨兵值，
            // 对多边形显式发 1.0 会被本域白名单与内核同时判为非法。
            if kind == "star" {
                let ratio = bounded(input.star_ratio, 0.01, 1.0, "星形内外比例")?;
                if ratio >= 1.0 {
                    return Err(bad("星形内外比例必须小于 1"));
                }
                params["starRatio"] = json!(ratio);
            }
        }
        _ => return Err(bad(format!("{kind} 不是可拖绘的形状种类"))),
    }
    Ok(params)
}

/// 命中阈值的源像素换算：屏幕阈值除以缩放，得到稳定的可点区域。
pub fn hit_tolerance(screen_px: f64, zoom: f64) -> f64 {
    if !screen_px.is_finite() || !zoom.is_finite() || zoom <= 0.0 {
        return screen_px.max(0.0);
    }
    (screen_px / zoom).clamp(1e-4, 1e6)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drag(kind: &str, start: [f64; 2], end: [f64; 2]) -> DrawInput {
        DrawInput {
            kind: kind.into(),
            start,
            end,
            modifiers: ShapeModifiers::default(),
            radius: 0.0,
            sides: 5,
            star_ratio: 0.5,
            weight: 2.0,
        }
    }

    #[test]
    fn drag_rects_are_flipped_into_positive_source_geometry() {
        let g = shape_geometry(&drag("rect", [40.0, 30.0], [10.0, 5.0]), [100, 100]).unwrap();
        assert_eq!(g.rect, [10.0, 5.0, 30.0, 25.0]);
        // 零面积拒绝，不产生半成品。
        assert!(shape_geometry(&drag("rect", [10.0, 10.0], [10.0, 10.0]), [100, 100]).is_err());
        // 超出文档放宽范围拒绝。
        assert!(shape_geometry(&drag("rect", [0.0, 0.0], [1e9, 10.0]), [100, 100]).is_err());
    }

    #[test]
    fn shift_squares_and_alt_centres_share_one_geometry() {
        let mut input = drag("ellipse", [50.0, 50.0], [90.0, 60.0]);
        input.modifiers.constrain = true;
        let g = shape_geometry(&input, [200, 200]).unwrap();
        assert_eq!(g.rect, [50.0, 50.0, 40.0, 40.0]);
        input.modifiers.from_center = true;
        input.start = [100.0, 100.0];
        input.end = [120.0, 110.0];
        let g = shape_geometry(&input, [200, 200]).unwrap();
        assert_eq!(g.rect, [80.0, 80.0, 40.0, 40.0]);
    }

    #[test]
    fn shift_lines_snap_to_fifteen_degrees_and_zero_length_is_refused() {
        let mut input = drag("line", [0.0, 0.0], [60.0, 3.0]);
        input.modifiers.constrain = true;
        let g = shape_geometry(&input, [200, 200]).unwrap();
        // 15° 内吸附到水平：角度归零，长度保持。
        assert!(g.to[1].abs() < 1e-6, "{:?}", g.to);
        assert!((g.to[0] - (60.0_f64 * 60.0 + 9.0).sqrt()).abs() < 1e-6);
        assert!(shape_geometry(&drag("line", [5.0, 5.0], [5.0, 5.0]), [200, 200]).is_err());
    }

    #[test]
    fn shape_params_carry_the_documented_kind_specific_fields() {
        let mut input = drag("roundedRect", [0.0, 0.0], [80.0, 40.0]);
        input.radius = 8.0;
        let params = shape_create_params(&input, [200, 200]).unwrap();
        assert_eq!(params["kind"], "roundedRect");
        assert_eq!(params["radii"], json!([8.0, 8.0, 8.0, 8.0]));
        assert_eq!(params["rect"], json!([0.0, 0.0, 80.0, 40.0]));

        let mut star = drag("star", [0.0, 0.0], [50.0, 50.0]);
        star.sides = 6;
        star.star_ratio = 0.4;
        let params = shape_create_params(&star, [200, 200]).unwrap();
        assert_eq!(params["sides"], 6);
        assert_eq!(params["starRatio"], 0.4);

        // 三角形固定三边，多边形按输入。
        let params = shape_create_params(&drag("triangle", [0.0, 0.0], [50.0, 50.0]), [200, 200]).unwrap();
        assert_eq!(params["sides"], 3);
        // 直线不带 rect，只带 from/to/weight。
        let line = shape_create_params(&drag("line", [1.0, 2.0], [30.0, 40.0]), [200, 200]).unwrap();
        assert_eq!(line["from"], json!([1.0, 2.0]));
        assert_eq!(line["to"], json!([30.0, 40.0]));
        assert_eq!(line["weight"], 2.0);
        assert!(line.get("rect").is_none());
    }

    #[test]
    fn illegal_shape_parameters_are_rejected_instead_of_clamped() {
        let mut input = drag("polygon", [0.0, 0.0], [40.0, 40.0]);
        input.sides = 2;
        assert!(shape_create_params(&input, [200, 200]).is_err());
        input.sides = 101;
        assert!(shape_create_params(&input, [200, 200]).is_err());
        let mut star = drag("star", [0.0, 0.0], [40.0, 40.0]);
        star.star_ratio = 1.0;
        assert!(shape_create_params(&star, [200, 200]).is_err());
        star.star_ratio = 0.0;
        assert!(shape_create_params(&star, [200, 200]).is_err());
        let mut rounded = drag("roundedRect", [0.0, 0.0], [40.0, 20.0]);
        rounded.radius = 30.0;
        assert!(shape_create_params(&rounded, [200, 200]).is_err(), "圆角半径不能超过短边一半");
        let mut unknown = drag("hexagon", [0.0, 0.0], [40.0, 20.0]);
        unknown.kind = "hexagon".into();
        assert!(shape_create_params(&unknown, [200, 200]).is_err());
    }

    #[test]
    fn hit_tolerance_is_a_screen_threshold_in_source_pixels() {
        assert_eq!(hit_tolerance(6.0, 1.0), 6.0);
        assert_eq!(hit_tolerance(6.0, 0.5), 12.0);
        assert_eq!(hit_tolerance(6.0, 4.0), 1.5);
        assert_eq!(hit_tolerance(6.0, 0.0), 6.0);
    }
}
