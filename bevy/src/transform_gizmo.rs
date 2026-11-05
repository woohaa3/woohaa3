//! Reusable disposable handles. The host owns tools, permissions, previews and commits.
use crate::gizmo_layout::render::{GizmoPalette, GizmoRenderAssets, sync_lines};
use crate::gizmo_layout::{GizmoLine, GizmoShape, GizmoView};
use bevy::{camera::visibility::RenderLayers, prelude::*};
pub const TRANSFORM_GIZMO_LAYER: usize = 1;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransformGizmoMode {
    Placement,
    FocusAxes,
    Yaw,
    Scale,
}
#[derive(Resource, Clone, Debug)]
pub struct TransformGizmoStyle {
    pub palette: GizmoPalette,
    pub layers: RenderLayers,
}
impl Default for TransformGizmoStyle {
    fn default() -> Self {
        Self {
            palette: GizmoPalette::default(),
            layers: RenderLayers::layer(TRANSFORM_GIZMO_LAYER),
        }
    }
}
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct TransformGizmoTarget {
    pub focus: Vec3,
    pub radius: f32,
}
#[derive(Resource, Default)]
pub struct TransformGizmoSelection {
    pub mode: Option<TransformGizmoMode>,
    pub target: Option<TransformGizmoTarget>,
    pub view: Option<GizmoView>,
    pub basis: Mat3,
    pub hover: Option<String>,
    pub active: Option<String>,
    pub entities: Vec<Entity>,
    pub grid: Option<(Vec3, f32)>,
    pub grid_entities: Vec<Entity>,
}
#[derive(Component, Clone)]
pub struct TransformGizmoHandle;
pub struct TransformGizmoPlugin;
impl Plugin for TransformGizmoPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TransformGizmoSelection>()
            .init_resource::<TransformGizmoStyle>()
            .init_resource::<GizmoRenderAssets>()
            .add_systems(PostUpdate, sync_transform_gizmo.run_if(crate::canvas_activity::running));
    }
}
impl TransformGizmoSelection {
    pub fn set(&mut self, mode: Option<TransformGizmoMode>, target: Option<TransformGizmoTarget>) {
        self.mode = mode;
        self.target = target;
    }
}
pub(crate) fn sync_transform_gizmo(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut assets: ResMut<GizmoRenderAssets>,
    style: Res<TransformGizmoStyle>,
    mut selection: ResMut<TransformGizmoSelection>,
) {
    assets.sync_palette(&mut materials, &style.palette);
    let grid_lines = selection
        .grid
        .zip(selection.view)
        .map(|((origin, spacing), _)| reference_grid(origin, spacing))
        .unwrap_or_default();
    if let Some(view) = selection.view {
        sync_lines(
            &mut commands,
            &mut assets,
            &mut meshes,
            &mut selection.grid_entities,
            TransformGizmoHandle,
            &grid_lines,
            &view,
            style.layers.clone(),
            None,
            None,
        );
    } else {
        for entity in selection.grid_entities.drain(..) {
            commands.entity(entity).try_despawn();
        }
    }

    let layout = selection
        .mode
        .zip(selection.target)
        .zip(selection.view)
        .and_then(|((mode, target), view)| {
            transform_handles(&view, target.focus, mode, selection.basis)
                .map(|lines| (view, lines))
        });
    if let Some((view, lines)) = layout {
        let hover = selection.hover.clone();
        let active = selection.active.clone();
        sync_lines(
            &mut commands,
            &mut assets,
            &mut meshes,
            &mut selection.entities,
            TransformGizmoHandle,
            &lines,
            &view,
            style.layers.clone(),
            hover.as_deref(),
            active.as_deref(),
        );
    } else {
        for entity in selection.entities.drain(..) {
            commands.entity(entity).try_despawn();
        }
    }
}

/// 编辑器手柄几何：三轴平移、绕 Y 旋转环或对角缩放。只用于屏幕绘制与命中。
pub(crate) fn transform_handles(
    view: &GizmoView,
    origin: Vec3,
    mode: TransformGizmoMode,
    basis: Mat3,
) -> Option<Vec<GizmoLine>> {
    const AXIS_CSS: f32 = 88.0;
    const YAW_RADIUS_CSS: f32 = 64.0;
    let scale = view.world_per_css(origin)?;
    view.project(origin)?;
    let mut lines = Vec::new();
    fn push(
        lines: &mut Vec<GizmoLine>,
        shape: GizmoShape,
        start: Vec3,
        end: Vec3,
        width_css: f32,
        handle: &'static str,
    ) {
        lines.push(GizmoLine {
            shape,
            start,
            end,
            width_css,
            handle,
            secondary: false,
            rear: false,
            visible: true,
        });
    }
    match mode {
        TransformGizmoMode::Yaw => {
            let u = basis * Vec3::X;
            let v = basis * Vec3::NEG_Z;
            let size = u.length().max(v.length());
            if !u.is_finite() || !v.is_finite() || size <= 1e-8 {
                return None;
            }
            let u = u * scale * YAW_RADIUS_CSS / size;
            let v = v * scale * YAW_RADIUS_CSS / size;
            let point = |angle: f32| origin + u * angle.cos() + v * angle.sin();
            for i in 0..crate::gizmo_layout::RING_SEGMENTS {
                let a = i as f32 / crate::gizmo_layout::RING_SEGMENTS as f32
                    * std::f32::consts::TAU;
                let b = (i + 1) as f32 / crate::gizmo_layout::RING_SEGMENTS as f32
                    * std::f32::consts::TAU;
                push(&mut lines, GizmoShape::Stroke, point(a), point(b), 3.0, "yaw-ring");
                let rear = (((point(a) + point(b)) * 0.5) - origin)
                    .dot(view.position - origin)
                    < 0.0;
                if let Some(line) = lines.last_mut() {
                    line.rear = rear;
                }
            }
        }
        TransformGizmoMode::Scale => {
            let tip = origin + (view.right + view.up).normalize() * scale * 64.0;
            if view.project(tip).is_some() {
                push(&mut lines, GizmoShape::Stroke, origin, tip, 2.5, "scale");
                push(
                    &mut lines,
                    GizmoShape::Cube,
                    tip - view.forward * scale * 5.0,
                    tip + view.forward * scale * 5.0,
                    10.0,
                    "scale",
                );
            }
        }
        TransformGizmoMode::Placement | TransformGizmoMode::FocusAxes => {
            let screen = view.project(origin)?;
            for (index, axis) in [Vec3::X, Vec3::Y, Vec3::Z].into_iter().enumerate() {
                let tip = origin + axis * (scale * AXIS_CSS);
                let Some(projected) = view.project(tip) else {
                    continue;
                };
                let delta = projected - screen;
                if delta.length() < 12.0 {
                    continue;
                }
                let handle = ["x", "y", "z"][index];
                let end = tip - axis * scale * 15.0;
                push(&mut lines, GizmoShape::Stroke, origin + axis * scale * 10.0, end, 2.5, handle);
                push(&mut lines, GizmoShape::Cone, end, tip, 11.0, handle);
            }
            push(
                &mut lines,
                GizmoShape::Cube,
                origin - view.forward * scale * 5.0,
                origin + view.forward * scale * 5.0,
                10.0,
                "center",
            );
        }
    }
    Some(lines)
}

/// The editor grid is display-only and excluded from picking and capture layers.
///
/// 过原点的两条线是**世界轴**：沿 X 方向延展的那条是 X 轴，沿 Z 方向延展的那条是 Z 轴。
/// 没有轴线时只能靠明暗判断地面朝向，模型旋转后分不清哪个方向是 X。
///
/// 颜色复用 gizmo 的轴色：`handle` 填 `"x"` / `"z"`，`GizmoRenderAssets::material` 据此选中
/// 同一组材质角色，不新增调色板槽位。网格线不参与命中——命中查询走 `canvas_query::gizmo`
/// 里按 editor 状态重建的 `ObjectGizmoLayout`，与这里下发的展示线是两份数据。
fn reference_grid(origin: Vec3, spacing: f32) -> Vec<crate::gizmo_layout::GizmoLine> {
    if !origin.is_finite() || !spacing.is_finite() || spacing <= 0.0 {
        return Vec::new();
    }
    let mut lines = Vec::with_capacity(42);
    let extent = spacing * 10.0;
    for index in -10..=10 {
        let offset = index as f32 * spacing;
        // (起点, 终点, 轴线 handle)。固定地面 z 的线沿 X 方向延展，即 X 轴；固定地面 x 的线
        // 沿 Z 方向延展，即 Z 轴。handle 用 gizmo 的轴名，材质角色因此自动沿用轴色。
        let axis = if index == 0 {
            [
                ("x", origin + Vec3::new(-extent, 0.0, offset), origin + Vec3::new(extent, 0.0, offset)),
                ("z", origin + Vec3::new(offset, 0.0, -extent), origin + Vec3::new(offset, 0.0, extent)),
            ]
        } else {
            [
                ("", origin + Vec3::new(-extent, 0.0, offset), origin + Vec3::new(extent, 0.0, offset)),
                ("", origin + Vec3::new(offset, 0.0, -extent), origin + Vec3::new(offset, 0.0, extent)),
            ]
        };
        for (handle, start, end) in axis {
            lines.push(crate::gizmo_layout::GizmoLine {
                shape: crate::gizmo_layout::GizmoShape::Stroke,
                start,
                end,
                // 轴线比普通网格线粗一档，避免它在密集网格里被当成主网格线（每 8 格一条）。
                width_css: if handle.is_empty() { 0.6 } else { 1.2 },
                handle,
                // 全部走 `secondary` 的 30% 亮度：轴色需要能分辨，但不能比模型本身更抢眼。
                secondary: true,
                rear: false,
                visible: true,
            });
        }
    }
    lines
}

#[cfg(test)]
mod reference_grid_tests {
    use super::reference_grid;

    fn axis_lines() -> Vec<crate::gizmo_layout::GizmoLine> {
        reference_grid(bevy::prelude::Vec3::ZERO, 10.0)
    }

    #[test]
    fn origin_lines_carry_axis_handles_for_axis_colors() {
        let lines = axis_lines();
        let x_axis: Vec<_> = lines.iter().filter(|line| line.handle == "x").collect();
        let z_axis: Vec<_> = lines.iter().filter(|line| line.handle == "z").collect();
        assert_eq!(x_axis.len(), 1, "过原点的 X 轴只有一条");
        assert_eq!(z_axis.len(), 1, "过原点的 Z 轴只有一条");
        // X 轴沿世界 X 方向延展：两端 z 相同、x 相反。
        assert!((x_axis[0].start.z - x_axis[0].end.z).abs() < 1e-6);
        assert!((x_axis[0].start.x + x_axis[0].end.x).abs() < 1e-6);
        // Z 轴沿世界 Z 方向延展：两端 x 相同、z 相反。
        assert!((z_axis[0].start.x - z_axis[0].end.x).abs() < 1e-6);
        assert!((z_axis[0].start.z + z_axis[0].end.z).abs() < 1e-6);
    }

    #[test]
    fn axis_lines_are_heavier_than_plain_grid_lines() {
        let lines = axis_lines();
        let axis_width = lines.iter().find(|line| !line.handle.is_empty()).map(|line| line.width_css);
        let plain_width = lines.iter().find(|line| line.handle.is_empty()).map(|line| line.width_css);
        assert!(axis_width > plain_width, "轴线应比普通网格线粗");
    }

    #[test]
    fn degenerate_spacing_yields_no_lines() {
        assert!(reference_grid(bevy::prelude::Vec3::ZERO, 0.0).is_empty());
        assert!(reference_grid(bevy::prelude::Vec3::ZERO, f32::NAN).is_empty());
    }
}
