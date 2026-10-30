//! 圆角虚线矩形的几何辅助（change: fix-group-and-marquee-preview）。
//!
//! group 容器框与框选选区框都用虚线表达「这是结构/临时范围，不是实体卡片」。抽出共享
//! 模块避免两处各写一份 dash 切片逻辑，也便于单独测试。

use bevy::prelude::*;

use super::geometry::Geometry;

/// 虚线段长与间隔（世界坐标）。
const DASH_LENGTH: f32 = 10.0;
const DASH_GAP: f32 = 6.0;

/// Preserve world-length dash spacing across sampled curve segments.
pub(super) fn dashed_polyline(
    geometry: &mut Geometry,
    points: &[Vec2],
    border: f32,
    z: f32,
    color: u32,
) {
    dashed_polyline_with_phase(geometry, points, border, z, color, 0.);
}

/// Seed a branch from its join's distance along the main perimeter.
pub(super) fn dashed_polyline_with_phase(
    geometry: &mut Geometry,
    points: &[Vec2],
    border: f32,
    z: f32,
    color: u32,
    distance: f32,
) {
    dashed_polyline_with_phase_alpha(geometry, points, border, z, color, distance, 1.);
}

pub(super) fn dashed_polyline_alpha(
    geometry: &mut Geometry,
    points: &[Vec2],
    border: f32,
    z: f32,
    color: u32,
    alpha: f32,
) {
    dashed_polyline_with_phase_alpha(geometry, points, border, z, color, 0., alpha);
}

#[allow(clippy::too_many_arguments)]
fn dashed_polyline_with_phase_alpha(
    geometry: &mut Geometry,
    points: &[Vec2],
    border: f32,
    z: f32,
    color: u32,
    distance: f32,
    alpha: f32,
) {
    let period = DASH_LENGTH + DASH_GAP;
    let mut phase = distance.rem_euclid(period);
    for pair in points.windows(2) {
        let length = pair[0].distance(pair[1]);
        if !length.is_finite() || length <= 0.0001 {
            continue;
        }
        let direction = (pair[1] - pair[0]) / length;
        let mut offset = 0.0;
        while length - offset > 0.0001 {
            let drawing = phase < DASH_LENGTH;
            let boundary = if drawing { DASH_LENGTH } else { period };
            let step = (boundary - phase).min(length - offset);
            if drawing && step > 0.0001 {
                geometry.line_alpha(
                    pair[0] + direction * offset,
                    pair[0] + direction * (offset + step),
                    border,
                    z,
                    color,
                    alpha,
                );
            }
            offset += step;
            phase += step;
            if phase >= period - 0.0001 {
                phase = 0.0;
            } else if (phase - DASH_LENGTH).abs() < 0.0001 {
                phase = DASH_LENGTH;
            }
        }
    }
}

/// 画一个圆角虚线矩形（四边由等长短线拼成，圆角处用短弧近似）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn dashed_rounded_rect(
    geometry: &mut Geometry,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
    border: f32,
    z: f32,
    color: u32,
) {
    let right = x + width;
    let bottom = y + height;
    // 四条直边：把可用长度按 dash+gap 切片。
    for (a, b) in [
        (Vec2::new(x + radius, y), Vec2::new(right - radius, y)),
        (
            Vec2::new(x + radius, bottom),
            Vec2::new(right - radius, bottom),
        ),
        (Vec2::new(x, y + radius), Vec2::new(x, bottom - radius)),
        (
            Vec2::new(right, y + radius),
            Vec2::new(right, bottom - radius),
        ),
    ] {
        dashed_line(geometry, a, b, border, z, color);
    }
    // 圆角：用连续短弧近似（半径小，视觉上仍是圆角）。
    for (cx, cy, start) in [
        (right - radius, y + radius, -std::f32::consts::FRAC_PI_2),
        (right - radius, bottom - radius, 0.0),
        (x + radius, bottom - radius, std::f32::consts::FRAC_PI_2),
        (x + radius, y + radius, std::f32::consts::PI),
    ] {
        let steps = 6;
        for i in 0..steps {
            let a0 = start + (i as f32 / steps as f32) * std::f32::consts::FRAC_PI_2;
            let a1 = start + ((i + 1) as f32 / steps as f32) * std::f32::consts::FRAC_PI_2;
            geometry.line(
                Vec2::new(cx + a0.cos() * radius, cy + a0.sin() * radius),
                Vec2::new(cx + a1.cos() * radius, cy + a1.sin() * radius),
                border,
                z,
                color,
            );
        }
    }
}

/// 闭合多边形虚线：沿周长连续延续 dash phase，避免每个顶点重新起算
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
///
/// 只复用现有 `Geometry::line`；不新增材质或 renderer。`vertices` 按顺序闭合（末点连回首点），
/// 每个 dash 段按全局弧长切片，跨顶点时被边自然裁开但相位连续。
pub(crate) fn dashed_polygon(
    geometry: &mut Geometry,
    vertices: &[Vec2],
    border: f32,
    z: f32,
    color: u32,
) {
    if vertices.len() < 2 {
        return;
    }
    // 按顶点顺序的边列表（含闭合边），并累计弧长。
    let edges: Vec<(Vec2, Vec2)> = (0..vertices.len())
        .map(|index| (vertices[index], vertices[(index + 1) % vertices.len()]))
        .filter(|(a, b)| (*b - *a).length() > 0.0)
        .collect();
    if edges.is_empty() {
        return;
    }
    let lengths: Vec<f32> = edges.iter().map(|(a, b)| (*b - *a).length()).collect();
    let perimeter: f32 = lengths.iter().sum();
    let step = DASH_LENGTH + DASH_GAP;
    let mut edge_index = 0_usize;
    let mut edge_start = 0.0_f32; // 当前边在全局弧长的起点。
    let mut distance = 0.0_f32; // 全局弧长游标（dash 起点）。
    while distance < perimeter {
        let dash_end = (distance + DASH_LENGTH).min(perimeter);
        // 把 [distance, dash_end] 按边裁成若干子段。
        let mut cursor = distance;
        while cursor < dash_end {
            while edge_index < lengths.len() && cursor >= edge_start + lengths[edge_index] {
                edge_start += lengths[edge_index];
                edge_index += 1;
            }
            if edge_index >= edges.len() {
                break;
            }
            let (a, b) = edges[edge_index];
            let dir = (b - a) / lengths[edge_index];
            let local_start = cursor - edge_start;
            let local_end = (dash_end - edge_start).min(lengths[edge_index]);
            if local_end > local_start {
                geometry.line(a + dir * local_start, a + dir * local_end, border, z, color);
            }
            cursor = edge_start + lengths[edge_index];
        }
        distance += step;
    }
}

/// 一条由 dash/gap 组成的线段。
fn dashed_line(geometry: &mut Geometry, a: Vec2, b: Vec2, border: f32, z: f32, color: u32) {
    let total = (b - a).length();
    if total <= 0.0 {
        return;
    }
    let dir = (b - a) / total;
    let step = DASH_LENGTH + DASH_GAP;
    let mut offset = 0.0;
    while offset < total {
        let end = (offset + DASH_LENGTH).min(total);
        geometry.line(a + dir * offset, a + dir * end, border, z, color);
        offset += step;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_dashes_keep_length_across_sample_boundaries() {
        let mut geometry = Geometry::default();
        dashed_polyline(
            &mut geometry,
            &[
                Vec2::ZERO,
                Vec2::new(5., 0.),
                Vec2::new(14., 0.),
                Vec2::new(30., 0.),
            ],
            1.,
            0.,
            0xffffff,
        );
        let mesh = geometry.build();
        let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("positions");
        };
        assert!(points.iter().any(|p| p[0] == 0.));
        assert!(points.iter().any(|p| p[0] == 26.));
        assert!(
            points
                .iter()
                .all(|p| p[0] <= 10. || (p[0] >= 16. && p[0] <= 26.))
        );
    }

    #[test]
    fn branch_dashes_continue_the_parent_phase() {
        let mut geometry = Geometry::default();
        dashed_polyline_with_phase(
            &mut geometry,
            &[Vec2::ZERO, Vec2::new(32., 0.)],
            1.,
            0.,
            0xffffff,
            11.,
        );
        let mesh = geometry.build();
        let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("positions");
        };
        assert!(points.iter().any(|p| p[0] == 5.));
        assert!(points.iter().any(|p| p[0] == 31.));
        assert!(
            points
                .iter()
                .all(|p| (5.0..=15.).contains(&p[0]) || (21.0..=31.).contains(&p[0]))
        );
    }

    fn positions(geometry: Geometry) -> usize {
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len()
    }

    #[test]
    fn dashed_rect_emits_multiple_segments() {
        let mut geometry = Geometry::default();
        dashed_rounded_rect(
            &mut geometry,
            0.0,
            0.0,
            100.0,
            60.0,
            8.0,
            1.0,
            0.0,
            0xffffff,
        );
        // 四条边各切成多段，顶点数远多于一个实心矩形。
        assert!(positions(geometry) > 100);
    }

    #[test]
    fn zero_length_edge_is_skipped() {
        let mut geometry = Geometry::default();
        // 半径大于边长时直边退化为零长：不应 panic，圆角弧仍产出几何。
        dashed_rounded_rect(&mut geometry, 0.0, 0.0, 4.0, 4.0, 8.0, 1.0, 0.0, 0xffffff);
        assert!(positions(geometry) > 0);
    }
}
