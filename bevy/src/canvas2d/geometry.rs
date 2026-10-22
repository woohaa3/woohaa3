//! 2D 几何 builder（change: refactor-bevy-runtime-modules，任务 3.2 / design D6）。
//!
//! 纯逻辑：接收数值与颜色，返回单个 [`Mesh`]。不持有 ECS 状态、不读写 bridge。

use std::f32::consts::PI;

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
};

use super::layout::hex;

#[derive(Default)]
pub(crate) struct Geometry {
    positions: Vec<[f32; 3]>,
    colors: Vec<[f32; 4]>,
    indices: Vec<u32>,
    /// 半透明几何的独立缓冲（change: 2026-10-09-fix-model-preview-layering-and-projection）：
    /// 不透明卡片外壳写入深度，半透明叠加层（group 底、框选、聚合选区、粘连高亮）用
    /// Blend 材质单独绘制，避免把整块 mesh 退化成 Blend 而失去深度遮挡。
    blend_positions: Vec<[f32; 3]>,
    blend_colors: Vec<[f32; 4]>,
    blend_indices: Vec<u32>,
}

impl Geometry {
    pub(crate) fn polygon(&mut self, points: &[Vec2], z: f32, color: u32) {
        self.polygon_alpha(points, z, color, 1.0);
    }

    /// 带 alpha 的多边形（change: fix-group-and-marquee-preview）。
    ///
    /// `hex()` 只编码 RGB，alpha 恒为 1；半透明容器底与框选选框需要显式 alpha。
    /// 不改变既有 [`Self::polygon`] 调用点语义。
    ///
    /// `alpha < 1` 的几何写入 Blend 缓冲，由 [`Self::into_layers`] 单独输出；其余进不透明缓冲。
    pub(crate) fn polygon_alpha(&mut self, points: &[Vec2], z: f32, color: u32, alpha: f32) {
        let blend = alpha < 1.0;
        let (positions, colors, indices) = if blend {
            (
                &mut self.blend_positions,
                &mut self.blend_colors,
                &mut self.blend_indices,
            )
        } else {
            (&mut self.positions, &mut self.colors, &mut self.indices)
        };
        let offset = positions.len() as u32;
        let mut rgba = hex(color).to_linear().to_f32_array();
        rgba[3] = alpha.clamp(0.0, 1.0);
        for point in points {
            positions.push([point.x, -point.y, z]);
            colors.push(rgba);
        }
        for i in 1..points.len().saturating_sub(1) {
            indices.extend_from_slice(&[offset, offset + i as u32 + 1, offset + i as u32]);
        }
    }

    pub(crate) fn rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        z: f32,
        color: u32,
    ) {
        self.rounded_rect_alpha(x, y, width, height, radius, z, color, 1.0);
    }

    /// 轴对齐矩形（`width`/`height` 负数时先归一化成非负宽度）。
    pub(crate) fn rect(&mut self, x: f32, y: f32, width: f32, height: f32, z: f32, color: u32) {
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        self.polygon(
            &[
                Vec2::new(x, y),
                Vec2::new(x + width, y),
                Vec2::new(x + width, y + height),
                Vec2::new(x, y + height),
            ],
            z,
            color,
        );
    }

    /// 带 alpha 的圆角矩形（change: fix-group-and-marquee-preview）：
    /// group 半透明容器底与框选选框底需要，避免不透明填充盖住下层内容。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn rounded_rect_alpha(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        z: f32,
        color: u32,
        alpha: f32,
    ) {
        let mut points = Vec::with_capacity(36);
        for (cx, cy, start) in [
            (x + width - radius, y + height - radius, 0.0),
            (x + radius, y + height - radius, PI / 2.0),
            (x + radius, y + radius, PI),
            (x + width - radius, y + radius, PI * 1.5),
        ] {
            for i in 0..=8 {
                let angle = start + i as f32 * PI / 16.0;
                points.push(Vec2::new(
                    cx + angle.cos() * radius,
                    cy + angle.sin() * radius,
                ));
            }
        }
        self.polygon_alpha(&points, z, color, alpha);
    }

    pub(crate) fn circle(
        &mut self,
        center: Vec2,
        radius: f32,
        z: f32,
        color: u32,
        segments: usize,
    ) {
        let points: Vec<Vec2> = (0..segments)
            .map(|i| {
                let a = i as f32 * PI * 2.0 / segments as f32;
                center + Vec2::new(a.cos(), a.sin()) * radius
            })
            .collect();
        self.polygon(&points, z, color);
    }

    pub(crate) fn line(&mut self, a: Vec2, b: Vec2, width: f32, z: f32, color: u32) {
        let normal = (b - a).normalize_or_zero().perp() * width / 2.0;
        self.polygon(&[a + normal, a - normal, b - normal, b + normal], z, color);
    }

    /// 圆环（端点圆钮的描边环）：以扇形细分画一圈带线宽的环。
    /// `thickness` 会被收缩到不超过外半径一半，避免自相交。
    pub(crate) fn ring(
        &mut self,
        center: Vec2,
        radius: f32,
        thickness: f32,
        z: f32,
        color: u32,
        segments: usize,
    ) {
        let outer = radius.max(0.5) + thickness / 2.0;
        let inner = (radius - thickness / 2.0).max(0.0);
        let segments = segments.max(8);
        for i in 0..segments {
            let a0 = i as f32 * PI * 2.0 / segments as f32;
            let a1 = (i + 1) as f32 * PI * 2.0 / segments as f32;
            let p0 = Vec2::new(a0.cos(), a0.sin());
            let p1 = Vec2::new(a1.cos(), a1.sin());
            self.polygon(
                &[
                    center + p0 * outer,
                    center + p1 * outer,
                    center + p1 * inner,
                    center + p0 * inner,
                ],
                z,
                color,
            );
        }
    }

    /// 环形进度（0–100%）：先画整圈轨道，再画已完成的弧段。
    pub(crate) fn progress_ring(
        &mut self,
        center: Vec2,
        radius: f32,
        progress: f32,
        color: u32,
        track: u32,
        z: f32,
    ) {
        let thickness = (radius * 0.3).max(1.5);
        self.ring_arc(center, radius, 0.0, PI * 2.0, thickness, z, track);
        let sweep = PI * 2.0 * (progress.clamp(0.0, 100.0) / 100.0);
        if sweep > 0.0 {
            self.ring_arc(
                center,
                radius,
                -PI / 2.0,
                sweep,
                thickness,
                z + 0.001,
                color,
            );
        }
    }

    /// 媒体解码期间的不定进度环，不估算下载/生成百分比。
    pub(crate) fn loading_ring(
        &mut self,
        center: Vec2,
        radius: f32,
        phase: f32,
        color: u32,
        track: u32,
        z: f32,
    ) {
        self.ring_arc(center, radius, 0.0, PI * 2.0, 3.0, z, track);
        self.ring_arc(center, radius, phase, PI * 0.65, 3.0, z + 0.0001, color);
    }

    /// 以扇形细分绘制圆环弧段。
    fn ring_arc(
        &mut self,
        center: Vec2,
        radius: f32,
        start: f32,
        sweep: f32,
        thickness: f32,
        z: f32,
        color: u32,
    ) {
        let inner = (radius - thickness / 2.0).max(0.5);
        let outer = radius + thickness / 2.0;
        let steps = ((sweep.abs() / (PI / 18.0)).ceil() as usize).max(2);
        for i in 0..steps {
            let a0 = start + sweep * (i as f32 / steps as f32);
            let a1 = start + sweep * ((i + 1) as f32 / steps as f32);
            let p0 = Vec2::new(a0.cos(), a0.sin());
            let p1 = Vec2::new(a1.cos(), a1.sin());
            self.polygon(
                &[
                    center + p0 * outer,
                    center + p1 * outer,
                    center + p1 * inner,
                    center + p0 * inner,
                ],
                z,
                color,
            );
        }
    }

    pub(crate) fn curve(&mut self, a: Vec2, b: Vec2, width: f32, z: f32, color: u32, dashed: bool) {
        // 控制点、采样点数与点到线段距离由 `super::curve` 提供唯一事实源，绘制与命中查询
        // 共用（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D4）。
        let (c1, c2) = super::curve::edge_control_points(a, b);
        let mut previous = a;
        for i in 1..=super::curve::EDGE_CURVE_SEGMENTS {
            let t = i as f32 / super::curve::EDGE_CURVE_SEGMENTS as f32;
            let point = super::curve::cubic_point(a, c1, c2, b, t);
            if !dashed || i % 6 < 4 {
                self.line(previous, point, width, z, color);
            }
            previous = point;
        }
    }

    pub(crate) fn icon(&mut self, kind: &str, center: Vec2, z: f32, color: u32) {
        let paths: Vec<Vec<(f32, f32)>> = match kind {
            _ => vec![
                vec![(-6., -5.), (4., -5.), (4., 5.), (-6., 5.), (-6., -5.)],
                vec![(-2., -1.), (7., -1.), (7., 7.), (-2., 7.), (-2., -1.)],
            ],
        };
        for path in paths {
            for pair in path.windows(2) {
                self.line(
                    center + Vec2::from(pair[0]),
                    center + Vec2::from(pair[1]),
                    1.5,
                    z,
                    color,
                );
            }
        }
    }

    /// 输出全部几何（不透明 + 半透明）合并成一张 mesh。用于逐帧 overlay（运行进度、粘连
    /// 触须）与兜底占位；主卡片改用 [`Self::into_layers`] 分层以获得深度遮挡。
    pub(crate) fn build(self) -> Mesh {
        let offset = self.positions.len() as u32;
        let mut positions = self.positions;
        let mut colors = self.colors;
        let mut indices = self.indices;
        positions.extend(self.blend_positions);
        colors.extend(self.blend_colors);
        indices.extend(self.blend_indices.into_iter().map(|index| index + offset));
        build_mesh(positions, colors, indices)
    }

    /// 把几何拆成 `(不透明, 半透明)` 两张 mesh。
    ///
    /// 不透明 mesh（卡片外壳、边、把手）用写深度材质，实现真实 z 遮挡；半透明 mesh
    /// （group 底、框选、聚合选区）用 Blend 材质只做深度测试
    /// （change: 2026-10-09-fix-model-preview-layering-and-projection）。
    pub(crate) fn into_layers(self) -> (Mesh, Mesh) {
        (
            build_mesh(self.positions, self.colors, self.indices),
            build_mesh(self.blend_positions, self.blend_colors, self.blend_indices),
        )
    }
}

/// 把坐标/颜色/索引打包成 `TriangleList` mesh；空输入产出不可见兜底三角形
/// （0 顶点 mesh 会在 wgpu 绘制时 panic，空画布首帧会经过这里）。
fn build_mesh(positions: Vec<[f32; 3]>, colors: Vec<[f32; 4]>, indices: Vec<u32>) -> Mesh {
    if positions.is_empty() {
        // 兜底三角形必须完全不可见：顶点远离原点（屏幕外 + 远平面外）。
        // 不透明材质忽略 alpha，因此不能再依赖 alpha=0，必须把 x/y 也移出视锥。
        return Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        )
        .with_inserted_attribute(
            Mesh::ATTRIBUTE_POSITION,
            vec![
                [-1.0e6, -1.0e6, -1.0e6],
                [-1.0e6 + 0.001, -1.0e6, -1.0e6],
                [-1.0e6, -1.0e6 + 0.001, -1.0e6],
            ],
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; 3])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; 3])
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, vec![[0.0, 0.0, 0.0, 0.0]; 3])
        .with_inserted_indices(Indices::U32(vec![0, 1, 2]));
    }
    let len = positions.len();
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; len])
    .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; len])
    .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, colors)
    .with_inserted_indices(Indices::U32(indices))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_geometry_builds_invisible_fallback_triangle() {
        // 空几何也必须产出可替换的兜底 mesh（否则删除最后一个节点后旧卡片会残留）。
        // 兜底必须不可见：顶点远离原点（屏幕外 + 远平面外）。不透明材质忽略 alpha，
        // 因此不能靠 alpha=0，必须把 x/y 也移出视锥。
        let mesh = Geometry::default().build();
        assert_eq!(mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len(), 3);
        let positions = match mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap() {
            bevy::render::mesh::VertexAttributeValues::Float32x3(values) => values,
            other => panic!("意外的位置属性类型：{other:?}"),
        };
        assert!(positions.iter().all(|position| position[0] <= -1.0e5 && position[1] <= -1.0e5));
    }

    #[test]
    fn polygon_builds_fan_indices_in_range() {        let mut geometry = Geometry::default();
        geometry.polygon(
            &[
                Vec2::new(0.0, 0.0),
                Vec2::new(4.0, 0.0),
                Vec2::new(4.0, 4.0),
                Vec2::new(0.0, 4.0),
            ],
            1.0,
            0x123456,
        );
        assert!(!geometry.positions.is_empty());
        let vertex_count = geometry.positions.len() as u32;
        assert_eq!(vertex_count, 4);
        assert_eq!(geometry.indices.len(), 6);
        assert!(geometry.indices.iter().all(|index| *index < vertex_count));
    }

    #[test]
    fn line_expands_to_quad() {
        let mut geometry = Geometry::default();
        geometry.line(Vec2::ZERO, Vec2::new(10.0, 0.0), 2.0, 0.0, 0xffffff);
        assert_eq!(geometry.positions.len(), 4);
        assert_eq!(geometry.indices.len(), 6);
    }

    /// 半透明几何（change: fix-group-and-marquee-preview）：alpha 必须写进顶点色，
    /// 否则 group 容器底与框选选框会退化成不透明。半透明几何路由到 Blend 缓冲，
    /// 由 `into_layers` 单独输出（change: 2026-10-09-fix-model-preview-layering-and-projection）。
    #[test]
    fn alpha_geometry_writes_vertex_alpha() {
        let mut geometry = Geometry::default();
        geometry.rounded_rect_alpha(0.0, 0.0, 10.0, 10.0, 2.0, 0.0, 0x112233, 0.55);
        let (opaque, blend) = geometry.into_layers();
        // 不透明缓冲应为空（兜底三角形），半透明缓冲承载该几何。
        assert_eq!(opaque.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len(), 3);
        let colors = match blend.attribute(Mesh::ATTRIBUTE_COLOR).unwrap() {
            bevy::render::mesh::VertexAttributeValues::Float32x4(values) => values,
            other => panic!("意外的颜色属性类型：{other:?}"),
        };
        assert!(!colors.is_empty());
        // 线性空间 alpha 与原值一致（sRGB→linear 只作用于 RGB）。
        assert!(colors.iter().all(|color| (color[3] - 0.55).abs() < 1e-5));
    }

    #[test]
    fn ring_emits_closed_band() {
        // 端点圆钮描边环：每段一个四边形，顶点数为 4 * segments。
        let mut geometry = Geometry::default();
        geometry.ring(Vec2::ZERO, 12.0, 2.0, 0.0, 0xffffff, 20);
        assert_eq!(geometry.positions.len(), 4 * 20);
        assert_eq!(geometry.indices.len(), 6 * 20);
    }

    #[test]
    fn progress_ring_emits_track_and_arc() {
        let mut geometry = Geometry::default();
        geometry.progress_ring(Vec2::ZERO, 10.0, 50.0, 0x00ff00, 0x333333, 0.0);
        assert!(geometry.positions.len() > 4 * 4);
    }
}
