//! 旋转/缩放/平移的**唯一**可逆视图变换（U72，design D1）。
//!
//! 源坐标（文档像素）↔ 屏幕坐标（画布客户像素）必须走同一个矩阵。参考线命中、标尺、吸附阈值、
//! Navigator、测量与经纬读数都从这里换算，不能只在 CSS 上旋转图片。
//!
//! 约定：`offset` 是文档左上角在画布容器内的客户坐标（与 `CanvasViewport.left/top` 同一含义），
//! 旋转围绕文档中心，屏幕 +y 向下，角度顺时针为正。

use serde_json::{Value, json};

/// 一次视图的完整几何：缩放、平移与旋转。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewTransform {
    pub zoom: f64,
    pub offset: [f64; 2],
    pub rotation_degrees: f64,
}

impl Default for ViewTransform {
    fn default() -> Self {
        Self { zoom: 1.0, offset: [0.0, 0.0], rotation_degrees: 0.0 }
    }
}

/// 旋转量的合法范围：Photoshop 只允许小数角度，超过一圈没有意义。
pub const MAX_ROTATION_DEGREES: f64 = 360.0;

impl ViewTransform {
    /// 参数是否可用（缩放为正、偏移与角度有限、角度在 ±360 内）。
    pub fn validate(&self) -> Result<(), String> {
        if !self.zoom.is_finite() || self.zoom <= 0.0 || self.zoom > 32.0 {
            return Err("缩放必须是 0–32 之间的有限正数".into());
        }
        if !self.offset[0].is_finite() || !self.offset[1].is_finite() {
            return Err("视图偏移必须是有限数值".into());
        }
        if !self.rotation_degrees.is_finite() || self.rotation_degrees.abs() > MAX_ROTATION_DEGREES {
            return Err(format!("旋转角度必须在 ±{MAX_ROTATION_DEGREES} 度以内"));
        }
        Ok(())
    }

    fn radians(&self) -> f64 {
        self.rotation_degrees.to_radians()
    }

    /// 源坐标 → 客户坐标。`document` 是文档像素尺寸（旋转中心）。
    pub fn document_to_view(&self, point: [f64; 2], document: [f64; 2]) -> [f64; 2] {
        let center = [document[0] / 2.0, document[1] / 2.0];
        let (sin, cos) = self.radians().sin_cos();
        let dx = (point[0] - center[0]) * self.zoom;
        let dy = (point[1] - center[1]) * self.zoom;
        [
            self.offset[0] + center[0] * self.zoom + dx * cos - dy * sin,
            self.offset[1] + center[1] * self.zoom + dx * sin + dy * cos,
        ]
    }

    /// 客户坐标 → 源坐标（`document_to_view` 的精确逆）。
    pub fn view_to_document(&self, client: [f64; 2], document: [f64; 2]) -> [f64; 2] {
        let center = [document[0] / 2.0, document[1] / 2.0];
        let (sin, cos) = self.radians().sin_cos();
        let vx = client[0] - self.offset[0] - center[0] * self.zoom;
        let vy = client[1] - self.offset[1] - center[1] * self.zoom;
        [
            center[0] + (vx * cos + vy * sin) / self.zoom,
            center[1] + (-vx * sin + vy * cos) / self.zoom,
        ]
    }

    /// 屏幕像素阈值 → 源像素阈值（旋转不改变比例，只有缩放在缩放）。
    pub fn screen_threshold(&self, screen_px: f64) -> f64 {
        if !screen_px.is_finite() || screen_px < 0.0 { return 0.0; }
        screen_px / self.zoom
    }

    /// 文档边界的四个角在客户坐标下的位置（Navigator 外框与旋转命中框使用）。
    pub fn document_corners(&self, document: [f64; 2]) -> [[f64; 2]; 4] {
        [
            self.document_to_view([0.0, 0.0], document),
            self.document_to_view([document[0], 0.0], document),
            self.document_to_view([document[0], document[1]], document),
            self.document_to_view([0.0, document[1]], document),
        ]
    }
}

/// 视图几何的只读快照（WASM 与 React 共用同一份数据）。
pub fn transform_json(transform: &ViewTransform) -> Value {
    json!({
        "zoom": transform.zoom,
        "offset": transform.offset,
        "rotation": transform.rotation_degrees,
        "valid": transform.validate().is_ok(),
    })
}

/// 一条参考线的命中结果（源坐标 + 索引）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GuideHit {
    pub vertical: bool,
    pub index: usize,
    /// 参考线在源坐标里的位置。
    pub position: f64,
    /// 命中点到参考线的源像素距离；多线重叠时取最小者。
    pub distance: f64,
}

/// 客户坐标下命中哪条参考线（U70 已有线命中/拖动）。
///
/// 判定在**源坐标**里做，因此旋转任意角度都成立：先逆变换到源坐标，再和线位置比距离；容差换成源
/// 像素（`screen_px / zoom`）后再比较，保证缩放后手感一致。与 TS
/// `features/views/view-transform.ts` 的 `hitGuide` 逐公式一致。
pub fn hit_guide(
    transform: &ViewTransform,
    client: [f64; 2],
    document: [f64; 2],
    vertical: &[f64],
    horizontal: &[f64],
    tolerance_px: f64,
) -> Option<GuideHit> {
    let tolerance = transform.screen_threshold(tolerance_px);
    if !(tolerance > 0.0) {
        return None;
    }
    let source = transform.view_to_document(client, document);
    if source.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let mut best: Option<GuideHit> = None;
    for (is_vertical, positions) in [(true, vertical), (false, horizontal)] {
        for (index, position) in positions.iter().enumerate() {
            let distance = ((if is_vertical { source[0] } else { source[1] }) - position).abs();
            if distance > tolerance {
                continue;
            }
            if best.is_some_and(|current| current.distance <= distance) {
                continue;
            }
            best = Some(GuideHit { vertical: is_vertical, index, position: *position, distance });
        }
    }
    best
}

/// 拖动中的参考线在源坐标里的新位置（U70 拖动）。
///
/// 夹取到画布边界内并保留两位小数；越界拖动留在边界上，而不是返回 `None` 让界面卡在上一帧。
pub fn guide_drag_position(transform: &ViewTransform, client: [f64; 2], document: [f64; 2], vertical: bool) -> Option<f64> {
    let source = transform.view_to_document(client, document);
    if source.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let limit = (if vertical { document[0] } else { document[1] }).max(0.0);
    let value = (if vertical { source[0] } else { source[1] }).clamp(0.0, limit);
    Some((value * 100.0).round() / 100.0)
}

/// 标尺原点拖动（U70）：客户指针对应的源坐标（两位小数）。
pub fn ruler_origin_at(transform: &ViewTransform, client: [f64; 2], document: [f64; 2]) -> Option<[f64; 2]> {
    let source = transform.view_to_document(client, document);
    if source.iter().any(|value| !value.is_finite()) {
        return None;
    }
    Some([(source[0] * 100.0).round() / 100.0, (source[1] * 100.0).round() / 100.0])
}

/// 标尺读数：源坐标相对标尺原点（U70/U73 的 Info 与标尺共用）。
///
/// 只做原点偏移；单位换算仍由 [`super::composition_domain::format_length`] 统一负责，
/// 这里不重复定义第二套单位规则。
pub fn ruler_reading(source: [f64; 2], origin: [f64; 2]) -> [f64; 2] {
    [source[0] - origin[0], source[1] - origin[1]]
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: [f64; 2] = [200.0, 100.0];

    fn approx(actual: [f64; 2], expected: [f64; 2]) {
        assert!((actual[0] - expected[0]).abs() < 1e-9, "{actual:?} != {expected:?}");
        assert!((actual[1] - expected[1]).abs() < 1e-9, "{actual:?} != {expected:?}");
    }

    #[test]
    fn identity_maps_the_document_corner_to_the_offset() {
        let transform = ViewTransform::default();
        approx(transform.document_to_view([0.0, 0.0], DOCUMENT), [0.0, 0.0]);
        approx(transform.document_to_view(DOCUMENT, DOCUMENT), DOCUMENT);
        approx(transform.view_to_document([0.0, 0.0], DOCUMENT), [0.0, 0.0]);
    }

    #[test]
    fn rotation_is_reversible_around_the_document_center() {
        for degrees in [0.0, 15.0, 30.0, -45.0, 90.0, 180.0, 359.5] {
            for offset in [[0.0, 0.0], [37.0, -12.0]] {
                let transform = ViewTransform { zoom: 1.7, offset, rotation_degrees: degrees };
                for point in [[0.0, 0.0], [200.0, 100.0], [12.5, 88.25], [-30.0, 140.0]] {
                    approx(transform.view_to_document(transform.document_to_view(point, DOCUMENT), DOCUMENT), point);
                }
                // 旋转中心本身保持不动。
                approx(
                    transform.document_to_view([100.0, 50.0], DOCUMENT),
                    [offset[0] + 100.0 * transform.zoom, offset[1] + 50.0 * transform.zoom],
                );
            }
        }
    }

    #[test]
    fn a_quarter_turn_maps_the_document_axis_onto_the_screen_axis() {
        let transform = ViewTransform { zoom: 1.0, offset: [0.0, 0.0], rotation_degrees: 90.0 };
        // 顺时针 90°：源 +x 变成屏幕 +y。
        approx(transform.document_to_view([200.0, 50.0], DOCUMENT), [100.0, 150.0]);
        approx(transform.document_to_view([100.0, 0.0], DOCUMENT), [150.0, 50.0]);
    }

    #[test]
    fn thresholds_and_bounds_follow_zoom_and_rotation() {
        let transform = ViewTransform { zoom: 2.0, offset: [0.0, 0.0], rotation_degrees: 30.0 };
        assert_eq!(transform.screen_threshold(8.0), 4.0);
        assert_eq!(transform.screen_threshold(-1.0), 0.0);
        assert_eq!(transform.screen_threshold(f64::NAN), 0.0);
        let corners = transform.document_corners(DOCUMENT);
        assert_eq!(corners.len(), 4);
        for corner in corners {
            assert!(corner[0].is_finite() && corner[1].is_finite());
        }
    }

    #[test]
    fn invalid_transforms_are_rejected_with_a_reason() {
        assert!(ViewTransform { zoom: 0.0, ..Default::default() }.validate().is_err());
        assert!(ViewTransform { zoom: f64::NAN, ..Default::default() }.validate().is_err());
        assert!(ViewTransform { rotation_degrees: 361.0, ..Default::default() }.validate().is_err());
        assert!(ViewTransform { offset: [f64::INFINITY, 0.0], ..Default::default() }.validate().is_err());
        assert!(ViewTransform { zoom: 4.0, offset: [10.0, 20.0], rotation_degrees: -90.0 }.validate().is_ok());
    }
}
