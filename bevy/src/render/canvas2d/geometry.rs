//! 2D 几何 builder（change: refactor-bevy-runtime-modules，任务 3.2 / design D6）。
//!
//! 纯逻辑：接收数值与颜色，返回单个 [`Mesh`]。不持有 ECS 状态、不读写 bridge。

use std::{f32::consts::PI, sync::OnceLock};

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
};

/// 8-bit sRGB → 线性 RGB 查表：几何构面高频调色，避免逐多边形重复调用 `powf`。
fn linear_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        std::array::from_fn(|value| Color::srgb_u8(value as u8, 0, 0).to_linear().red)
    })
}

#[inline]
fn linear_rgba(color: u32, alpha: f32) -> [f32; 4] {
    let lut = linear_lut();
    [
        lut[((color >> 16) & 0xff) as usize],
        lut[((color >> 8) & 0xff) as usize],
        lut[(color & 0xff) as usize],
        alpha.clamp(0.0, 1.0),
    ]
}

/// Presentation subdivision tiers for edge curves.  The fixed query sampler remains in
/// `canvas_query::curve::EDGE_CURVE_SEGMENTS`; these values only control rendered mesh density.
pub(crate) fn edge_curve_segments(zoom: f32) -> usize {
    if zoom <= 0.18 {
        12
    } else if zoom <= 0.45 {
        24
    } else {
        64
    }
}

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
        let rgba = linear_rgba(color, alpha);
        for point in points {
            positions.push([point.x, -point.y, z]);
            colors.push(rgba);
        }
        for i in 1..points.len().saturating_sub(1) {
            indices.extend_from_slice(&[offset, offset + i as u32 + 1, offset + i as u32]);
        }
    }

    /// Closed contour stroke without filling or repainting the interior.
    pub(crate) fn outline(&mut self, points: &[Vec2], width: f32, z: f32, color: u32) {
        if points.len() < 3 {
            return;
        }
        let offsets: Vec<_> = (0..points.len())
            .map(|i| {
                let previous = points[(i + points.len() - 1) % points.len()];
                let next = points[(i + 1) % points.len()];
                let a = (points[i] - previous).normalize_or_zero().perp();
                let b = (next - points[i]).normalize_or_zero().perp();
                let normal = (a + b).normalize_or_zero();
                normal * (width * 0.5 / normal.dot(b).abs().max(0.25))
            })
            .collect();
        for i in 0..points.len() {
            let j = (i + 1) % points.len();
            self.polygon(
                &[
                    points[i] + offsets[i],
                    points[i] - offsets[i],
                    points[j] - offsets[j],
                    points[j] + offsets[j],
                ],
                z,
                color,
            );
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
        self.rounded_rect_radii_alpha(x, y, width, height, [radius; 4], z, color, alpha);
    }

    /// 四角半径独立的圆角矩形，`radii` 顺序为左上、右上、右下、左下（画布 y 向下）。
    ///
    /// 圆角面板的四角半径独立可调；徽标固定在组矩形外侧，因此面板本身不需要再挖缺口。
    /// 三角化仍只处理面板自身的凸区域，尾巴由 3D surface 单独绘制。
    ///
    /// 半径 `0` 输出直角顶点；超过短边一半时收缩，避免自相交。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn rounded_rect_radii_alpha(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radii: [f32; 4],
        z: f32,
        color: u32,
        alpha: f32,
    ) {
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        let limit = width.min(height) / 2.0;
        let [top_left, top_right, bottom_right, bottom_left] = radii.map(|r| r.clamp(0.0, limit));
        let mut points = Vec::with_capacity(36);
        // 与 `rounded_rect_alpha` 相同的右下 → 左下 → 左上 → 右上弧段顺序，四角同半径时
        // 顶点序列与历史输出逐字节一致。
        for (cx, cy, start, radius) in [
            (
                x + width - bottom_right,
                y + height - bottom_right,
                0.0,
                bottom_right,
            ),
            (
                x + bottom_left,
                y + height - bottom_left,
                PI / 2.0,
                bottom_left,
            ),
            (x + top_left, y + top_left, PI, top_left),
            (x + width - top_right, y + top_right, PI * 1.5, top_right),
        ] {
            if radius <= 0.0 {
                points.push(Vec2::new(cx, cy));
                continue;
            }
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
        self.line_alpha(a, b, width, z, color, 1.);
    }

    pub(crate) fn line_alpha(
        &mut self,
        a: Vec2,
        b: Vec2,
        width: f32,
        z: f32,
        color: u32,
        alpha: f32,
    ) {
        let normal = (b - a).normalize_or_zero().perp() * width / 2.0;
        self.polygon_alpha(
            &[a + normal, a - normal, b - normal, b + normal],
            z,
            color,
            alpha,
        );
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

    /// 静态底层轨道环：旋转弧线改用共享网格的实体旋转。
    pub(crate) fn loading_track(&mut self, center: Vec2, radius: f32, track: u32, z: f32) {
        self.ring_arc(center, radius, 0.0, PI * 2.0, 3.0, z, track);
    }

    /// 独立的加载旋转弧共享网格（原点为圆心，绕 Z 轴旋转驱动动画）。
    pub(crate) fn spinner_arc_mesh(radius: f32, color: u32) -> Mesh {
        let mut geometry = Self::default();
        geometry.ring_arc(Vec2::ZERO, radius, 0.0, PI * 0.65, 3.0, 0.0, color);
        geometry.build()
    }

    /// 以连续三角形条带绘制圆环弧段（每步只写外内一对顶点）。
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
        let base = self.positions.len() as u32;
        let rgba = linear_rgba(color, 1.0);
        self.positions.reserve((steps + 1) * 2);
        self.colors.reserve((steps + 1) * 2);
        self.indices.reserve(steps * 6);
        for i in 0..=steps {
            let angle = start + sweep * (i as f32 / steps as f32);
            let dir = Vec2::new(angle.cos(), angle.sin());
            let po = center + dir * outer;
            let pi = center + dir * inner;
            self.positions.push([po.x, -po.y, z]);
            self.positions.push([pi.x, -pi.y, z]);
            self.colors.push(rgba);
            self.colors.push(rgba);
        }
        for i in 0..steps as u32 {
            let o0 = base + i * 2;
            let i0 = o0 + 1;
            let o1 = o0 + 2;
            let i1 = o0 + 3;
            self.indices.extend_from_slice(&[o0, i1, o1, o0, i0, i1]);
        }
    }

    pub(crate) fn curve(&mut self, a: Vec2, b: Vec2, width: f32, z: f32, color: u32, dashed: bool) {
        // 控制点、采样点数与点到线段距离由 `super::curve` 提供唯一事实源，绘制与命中查询
        // 共用（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D4）。
        let (c1, c2) = super::curve::edge_control_points(a, b);
        self.curve_with_controls(a, c1, c2, b, width, z, color, dashed);
    }

    /// Draw an edge curve using the subdivision tier appropriate for the current zoom.
    ///
    /// Hit testing continues to use the fixed 64 sample curve.  This is only a presentation
    /// LOD, so changing the tier cannot change interaction results.
    pub(crate) fn curve_lod(
        &mut self,
        a: Vec2,
        b: Vec2,
        width: f32,
        z: f32,
        color: u32,
        dashed: bool,
        zoom: f32,
    ) {
        let (c1, c2) = super::curve::edge_control_points(a, b);
        self.curve_with_controls_alpha_lod(
            a,
            c1,
            c2,
            b,
            width,
            z,
            color,
            dashed,
            1.0,
            edge_curve_segments(zoom),
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn curve_with_controls(
        &mut self,
        a: Vec2,
        c1: Vec2,
        c2: Vec2,
        b: Vec2,
        width: f32,
        z: f32,
        color: u32,
        dashed: bool,
    ) {
        self.curve_with_controls_alpha_lod(
            a,
            c1,
            c2,
            b,
            width,
            z,
            color,
            dashed,
            1.,
            super::curve::EDGE_CURVE_SEGMENTS,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn curve_with_controls_alpha(
        &mut self,
        a: Vec2,
        c1: Vec2,
        c2: Vec2,
        b: Vec2,
        width: f32,
        z: f32,
        color: u32,
        dashed: bool,
        alpha: f32,
    ) {
        self.curve_with_controls_alpha_lod(
            a,
            c1,
            c2,
            b,
            width,
            z,
            color,
            dashed,
            alpha,
            super::curve::EDGE_CURVE_SEGMENTS,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn curve_with_controls_alpha_lod(
        &mut self,
        a: Vec2,
        c1: Vec2,
        c2: Vec2,
        b: Vec2,
        width: f32,
        z: f32,
        color: u32,
        dashed: bool,
        alpha: f32,
        segments: usize,
    ) {
        let segments = segments.max(1);
        if dashed {
            // Dash spacing and its hit-test golden data remain tied to the fixed curve sampler.
            let points: Vec<_> = (0..=super::curve::EDGE_CURVE_SEGMENTS)
                .map(|i| {
                    super::curve::cubic_point(
                        a,
                        c1,
                        c2,
                        b,
                        i as f32 / super::curve::EDGE_CURVE_SEGMENTS as f32,
                    )
                })
                .collect();
            super::dash::dashed_polyline_alpha(self, &points, width, z, color, alpha);
            return;
        }
        let points: Vec<_> = (0..=segments)
            .map(|i| super::curve::cubic_point(a, c1, c2, b, i as f32 / segments as f32))
            .collect();
        self.polyline_strip_alpha(&points, width, z, color, alpha);
    }

    /// Append a continuous triangle strip for a stroked polyline.  Each sample contributes
    /// exactly two vertices; adjacent segments reuse the pair at their shared join.
    fn polyline_strip_alpha(
        &mut self,
        points: &[Vec2],
        width: f32,
        z: f32,
        color: u32,
        alpha: f32,
    ) {
        if points.len() < 2 || width <= 0.0 {
            return;
        }
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
        let half_width = width * 0.5;
        let rgba = linear_rgba(color, alpha);
        for i in 0..points.len() {
            let tangent = if i == 0 {
                points[1] - points[0]
            } else if i + 1 == points.len() {
                points[i] - points[i - 1]
            } else {
                (points[i] - points[i - 1]) + (points[i + 1] - points[i])
            };
            let tangent = tangent.normalize_or_zero();
            let normal = if tangent.length_squared() > f32::EPSILON {
                tangent.perp()
            } else {
                Vec2::Y
            };
            // A miter join keeps the stroke continuous.  Limit extreme bends so a very short
            // or repeated Bézier sample cannot produce an unbounded spike.
            let mut join = normal;
            if i > 0 && i + 1 < points.len() {
                let incoming = (points[i] - points[i - 1]).normalize_or_zero();
                let outgoing = (points[i + 1] - points[i]).normalize_or_zero();
                let incoming_normal = incoming.perp();
                let outgoing_normal = outgoing.perp();
                let miter = (incoming_normal + outgoing_normal).normalize_or_zero();
                let denominator = miter.dot(outgoing_normal).abs();
                if denominator > 0.25 {
                    join = miter * (1.0 / denominator).min(4.0);
                }
            }
            let offset_vec = join * half_width;
            positions.push([points[i].x + offset_vec.x, -(points[i].y + offset_vec.y), z]);
            positions.push([points[i].x - offset_vec.x, -(points[i].y - offset_vec.y), z]);
            colors.push(rgba);
            colors.push(rgba);
        }
        for i in 0..points.len() - 1 {
            let left = offset + (i * 2) as u32;
            let right = left + 1;
            let next_left = left + 2;
            let next_right = left + 3;
            indices.extend_from_slice(&[left, next_right, right, left, next_left, next_right]);
        }
    }

    /// 节点卡片左上角的类型图标：按节点种类绘制具象线稿（文本 / 图片 / 视频 / 3D / 镜头 /
    /// 音频），未知种类沿用通用叠片图标。坐标以 `center` 为原点、画布 y 向下，控制在
    /// 28×28 的图标格内。
    pub(crate) fn icon(&mut self, kind: &str, center: Vec2, z: f32, color: u32) {
        match kind {
            "text" => {
                // 大写 T：横画 + 中竖 + 底部衬线，与右键菜单的类型图标一致。
                self.icon_stroke(center, &[(-7., -6.), (7., -6.)], false, z, color);
                self.icon_stroke(center, &[(0., -6.), (0., 7.)], false, z, color);
                self.icon_stroke(center, &[(-3.5, 7.), (3.5, 7.)], false, z, color);
            }
            "image" => {
                // 相框 + 太阳 + 山脊。
                self.icon_stroke(
                    center,
                    &[(-8., -6.), (8., -6.), (8., 6.), (-8., 6.)],
                    true,
                    z,
                    color,
                );
                self.ring(center + Vec2::new(-3.8, -2.4), 1.5, 1.3, z, color, 16);
                self.icon_stroke(
                    center,
                    &[
                        (-7.6, 4.9),
                        (-2.4, -0.4),
                        (1.6, 3.1),
                        (4.4, 0.9),
                        (7.8, 4.6),
                    ],
                    false,
                    z,
                    color,
                );
            }
            "video" => {
                // 胶片框：外框 + 两道竖隔 + 三道横隔，与右键菜单的视频图标一致。
                self.icon_stroke(
                    center,
                    &[(-8., -6.5), (8., -6.5), (8., 6.5), (-8., 6.5)],
                    true,
                    z,
                    color,
                );
                self.icon_stroke(center, &[(-4., -6.5), (-4., 6.5)], false, z, color);
                self.icon_stroke(center, &[(4., -6.5), (4., 6.5)], false, z, color);
                self.icon_stroke(center, &[(-8., -3.25), (8., -3.25)], false, z, color);
                self.icon_stroke(center, &[(-8., 0.), (8., 0.)], false, z, color);
                self.icon_stroke(center, &[(-8., 3.25), (8., 3.25)], false, z, color);
            }
            "model" => {
                // 等距立方体：顶面、三条竖棱、底面。
                self.icon_stroke(
                    center,
                    &[(0., -7.), (7., -3.5), (0., 0.), (-7., -3.5)],
                    true,
                    z,
                    color,
                );
                self.icon_stroke(center, &[(-7., -3.5), (-7., 3.5)], false, z, color);
                self.icon_stroke(center, &[(0., 0.), (0., 7.)], false, z, color);
                self.icon_stroke(center, &[(7., -3.5), (7., 3.5)], false, z, color);
                self.icon_stroke(center, &[(-7., 3.5), (0., 7.), (7., 3.5)], false, z, color);
            }
            "shot" => {
                // 相机：机身 + 顶部取景凸起 + 镜头环。
                self.icon_stroke(
                    center,
                    &[(-8., -2.5), (8., -2.5), (8., 6.), (-8., 6.)],
                    true,
                    z,
                    color,
                );
                self.icon_stroke(
                    center,
                    &[(-4.5, -2.5), (-3., -6.), (3., -6.), (4.5, -2.5)],
                    false,
                    z,
                    color,
                );
                self.ring(center + Vec2::new(0., 1.75), 3.1, 1.4, z, color, 20);
            }
            "audio" => {
                // 音符：双符头 + 符杆 + 符杠。
                self.icon_stroke(center, &[(-3.5, 4.5), (-3.5, -5.)], false, z, color);
                self.icon_stroke(center, &[(3.5, 3.), (3.5, -6.5)], false, z, color);
                self.line(
                    center + Vec2::new(-3.5, -5.),
                    center + Vec2::new(3.5, -6.5),
                    2.5,
                    z,
                    color,
                );
                self.circle(center + Vec2::new(-4.6, 4.6), 2., z, color, 14);
                self.circle(center + Vec2::new(2.4, 3.1), 2., z, color, 14);
            }
            _ => {
                self.icon_stroke(
                    center,
                    &[(-6., -5.), (4., -5.), (4., 5.), (-6., 5.)],
                    true,
                    z,
                    color,
                );
                self.icon_stroke(
                    center,
                    &[(-2., -1.), (7., -1.), (7., 7.), (-2., 7.)],
                    true,
                    z,
                    color,
                );
            }
        }
    }

    /// 以折线描边图标路径；`closed` 时补一段回到起点。
    fn icon_stroke(
        &mut self,
        center: Vec2,
        points: &[(f32, f32)],
        closed: bool,
        z: f32,
        color: u32,
    ) {
        let Some(first) = points.first() else {
            return;
        };
        let mut previous = center + Vec2::new(first.0, first.1);
        for point in &points[1..] {
            let next = center + Vec2::new(point.0, point.1);
            self.line(previous, next, 1.5, z, color);
            previous = next;
        }
        if closed {
            self.line(
                previous,
                center + Vec2::new(first.0, first.1),
                1.5,
                z,
                color,
            );
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

    /// 把几何拆成不透明与半透明两层的原始缓冲；`from_layer_buffers` 可用它们原样重建。
    pub(crate) fn into_layer_buffers(
        self,
    ) -> (
        (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>),
        (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>),
    ) {
        (
            (self.positions, self.colors, self.indices),
            (self.blend_positions, self.blend_colors, self.blend_indices),
        )
    }

    /// 以两层原始缓冲构造几何（与 [`Self::into_layer_buffers`] 成对使用）。
    pub(crate) fn from_layer_buffers(
        opaque: (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>),
        translucent: (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>),
    ) -> Self {
        Self {
            positions: opaque.0,
            colors: opaque.1,
            indices: opaque.2,
            blend_positions: translucent.0,
            blend_colors: translucent.1,
            blend_indices: translucent.2,
        }
    }

    /// 取出原始顶点缓冲（横条覆盖层用它保留区间外的几何）。
    pub(crate) fn into_buffers(self) -> (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>) {
        (self.positions, self.colors, self.indices)
    }

    /// 直接以原始缓冲构造几何（不做合成/打包），与 [`Self::into_buffers`] 成对使用。
    pub(crate) fn from_buffers(
        positions: Vec<[f32; 3]>,
        colors: Vec<[f32; 4]>,
        indices: Vec<u32>,
    ) -> Self {
        Self {
            positions,
            colors,
            indices,
            ..Self::default()
        }
    }

    /// 把本帧新批次追加到保留缓冲之后：`retained` 是上一帧的原始缓冲，`spans` 是其中应当
    /// 保留的世界 x 区间（区间外的旧三角形被剔除）。产出的顶点顺序恒为「保留的旧顶点（原序）
    /// + 新顶点」，与对同一批内容做整层重建的顺序一致。
    pub(crate) fn append_retained(
        self,
        retained: (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>),
        spans: &[(f32, f32)],
    ) -> (Mesh, Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>) {
        let inside = |x: f32| {
            spans
                .iter()
                .any(|(start, end)| x >= *start - f32::EPSILON && x <= *end + f32::EPSILON)
        };
        let (retained_positions, retained_colors, retained_indices) = retained;
        let mut positions = Vec::with_capacity(retained_positions.len() + self.positions.len());
        let mut colors = Vec::with_capacity(retained_colors.len() + self.colors.len());
        let mut indices = Vec::with_capacity(retained_indices.len() + self.indices.len());
        // 先收拢区间内的保留三角形，再并入本帧新批次；丢弃的顶点不留在缓冲里，避免缓冲区随
        // 逐帧局部重绘无限增长。
        let mut kept = vec![u32::MAX; retained_positions.len()];
        for (index, position) in retained_positions.iter().enumerate() {
            if inside(position[0]) {
                kept[index] = positions.len() as u32;
                positions.push(*position);
                colors.push(retained_colors[index]);
            }
        }
        // 三角形只要有一个顶点落在保留范围内就整块留下：横条的圆角/描边三角形会跨越范围
        // 边界，按「全部顶点在内」剔除会削掉横条边缘。跨界的其余顶点按原序补进缓冲。
        let mut pending = vec![u32::MAX; retained_positions.len()];
        let mut triangles = Vec::with_capacity(retained_indices.len());
        for triangle in retained_indices.chunks_exact(3) {
            if !triangle
                .iter()
                .any(|index| kept.get(*index as usize).is_some_and(|k| *k != u32::MAX))
            {
                continue;
            }
            let mut mapped = [0u32; 3];
            for (slot, index) in triangle.iter().enumerate() {
                let index = *index as usize;
                if kept[index] == u32::MAX {
                    if pending[index] == u32::MAX {
                        pending[index] = positions.len() as u32;
                        positions.push(retained_positions[index]);
                        colors.push(retained_colors[index]);
                    }
                    mapped[slot] = pending[index];
                } else {
                    mapped[slot] = kept[index];
                }
            }
            triangles.extend_from_slice(&mapped);
        }
        indices.extend(triangles);
        let offset = positions.len() as u32;
        positions.extend(self.positions);
        colors.extend(self.colors);
        indices.extend(self.indices.into_iter().map(|index| index + offset));
        let mesh = build_mesh(positions.clone(), colors.clone(), indices.clone());
        (mesh, positions, colors, indices)
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

    fn bar(x: f32, color: u32) -> Geometry {
        let mut geometry = Geometry::default();
        geometry.rounded_rect(x, 0., 40., 30., 4., 100., color);
        geometry.circle(Vec2::new(x + 10., 15.), 4., 101., 0x445566, 12);
        geometry
    }

    fn assert_mesh_eq(left: &Mesh, right: &Mesh) {
        for attribute in [Mesh::ATTRIBUTE_POSITION, Mesh::ATTRIBUTE_COLOR] {
            assert_eq!(
                left.attribute(attribute),
                right.attribute(attribute),
                "{attribute:?}"
            );
        }
        assert_eq!(left.indices(), right.indices());
    }

    /// 局部重绘必须与整层全量重建逐顶点一致：保留范围内的横条原序在前，新批次追加在后。
    #[test]
    fn range_replacement_matches_a_full_rebuild_of_the_same_batches() {
        let mut base = Geometry::default();
        base.rounded_rect(0., 0., 40., 30., 4., 100., 0x112233);
        base.circle(Vec2::new(10., 15.), 4., 101., 0x445566, 12);
        base.rounded_rect(200., 0., 40., 30., 4., 100., 0x112233);
        base.circle(Vec2::new(210., 15.), 4., 101., 0x445566, 12);
        let retained = base.into_buffers();
        let moved = bar(200., 0x998877);
        let (merged, ..) = moved.append_retained(retained, &[(0., 40.)]);

        let mut full = Geometry::default();
        full.rounded_rect(0., 0., 40., 30., 4., 100., 0x112233);
        full.circle(Vec2::new(10., 15.), 4., 101., 0x445566, 12);
        full.rounded_rect(200., 0., 40., 30., 4., 100., 0x998877);
        full.circle(Vec2::new(210., 15.), 4., 101., 0x445566, 12);
        assert_mesh_eq(&merged, &full.build());
    }

    /// 保留范围外没有新批次时，旧横条必须消失（节点失去横条），范围内保留。
    #[test]
    fn cleared_range_drops_its_retained_geometry_only() {
        let mut base = Geometry::default();
        base.rounded_rect(0., 0., 40., 30., 4., 100., 0x112233);
        base.rounded_rect(200., 0., 40., 30., 4., 100., 0x445566);
        let retained = base.into_buffers();
        let (merged, ..) = Geometry::default().append_retained(retained, &[(0., 40.)]);
        let mut full = Geometry::default();
        full.rounded_rect(0., 0., 40., 30., 4., 100., 0x112233);
        assert_mesh_eq(&merged, &full.build());
    }

    #[test]
    fn empty_geometry_builds_invisible_fallback_triangle() {
        // 兜底必须不可见：顶点远离原点（屏幕外 + 远平面外）。不透明材质忽略 alpha，
        // 因此不能靠 alpha=0，必须把 x/y 也移出视锥。
        let mesh = Geometry::default().build();
        assert_eq!(mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len(), 3);
        let positions = match mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap() {
            bevy::render::mesh::VertexAttributeValues::Float32x3(values) => values,
            other => panic!("意外的位置属性类型：{other:?}"),
        };
        assert!(
            positions
                .iter()
                .all(|position| position[0] <= -1.0e5 && position[1] <= -1.0e5)
        );
    }

    #[test]
    fn polygon_builds_fan_indices_in_range() {
        let mut geometry = Geometry::default();
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

    /// 节点左上角图标按种类绘制具象线稿，且始终留在 28×28 图标格内。
    #[test]
    fn node_icon_kinds_draw_concrete_glyphs_inside_tile() {
        for kind in ["text", "image", "video", "model", "shot", "audio"] {
            let mut geometry = Geometry::default();
            geometry.icon(kind, Vec2::ZERO, 0.0, 0xffffff);
            assert!(
                geometry.positions.len() >= 8,
                "{kind} 图标应包含可辨识的笔画"
            );
            assert!(
                geometry
                    .positions
                    .iter()
                    .all(|position| position[0].abs() <= 14.0 && position[1].abs() <= 14.0),
                "{kind} 图标不应越出 28×28 图标格"
            );
        }
        // 未知种类仍回落到通用叠片图标，不留下空白格。
        let mut fallback = Geometry::default();
        fallback.icon("unknown", Vec2::ZERO, 0.0, 0xffffff);
        assert!(!fallback.positions.is_empty());
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

    /// 四角半径独立：直角输出单个顶点，圆角输出 9 点弧段。
    /// 组底靠它把「带徽章缺口的矩形」拆成三块凸多边形。
    #[test]
    fn rounded_rect_radii_keeps_square_corners_as_single_vertices() {
        let mut geometry = Geometry::default();
        geometry.rounded_rect_radii_alpha(
            0.0,
            0.0,
            100.0,
            40.0,
            [0., 0., 0., 12.],
            0.0,
            0xffffff,
            0.5,
        );
        let (_, blend) = geometry.into_layers();
        let positions = match blend.attribute(Mesh::ATTRIBUTE_POSITION).unwrap() {
            bevy::render::mesh::VertexAttributeValues::Float32x3(values) => values.clone(),
            other => panic!("意外的位置属性类型：{other:?}"),
        };
        assert_eq!(positions.len(), 3 + 9);
        // 左下圆角的最低点仍在矩形底边上。
        assert!(
            positions
                .iter()
                .any(|p| (p[0] - 12.).abs() < 1e-4 && (p[1] + 40.).abs() < 1e-4)
        );
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

    #[test]
    fn linear_rgba_lut_matches_bevy_srgb_conversion() {
        for color in [0x000000, 0x112233, 0x3b82f6, 0x84a1c3, 0xef6721, 0xffffff] {
            let expected = super::super::layout::hex(color).to_linear().to_f32_array();
            let actual = linear_rgba(color, 1.0);
            assert_eq!(actual, expected, "color={color:#08x}");
        }
        let half = linear_rgba(0x112233, 0.55);
        assert!((half[3] - 0.55).abs() < 1e-6);
    }
}
