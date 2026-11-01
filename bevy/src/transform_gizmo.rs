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
            .add_systems(PostUpdate, sync_transform_gizmo);
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
fn reference_grid(origin: Vec3, spacing: f32) -> Vec<crate::gizmo_layout::GizmoLine> {
    if !origin.is_finite() || !spacing.is_finite() || spacing <= 0.0 {
        return Vec::new();
    }
    let mut lines = Vec::with_capacity(42);
    let extent = spacing * 10.0;
    for index in -10..=10 {
        let offset = index as f32 * spacing;
        for (start, end) in [
            (
                origin + Vec3::new(-extent, 0.0, offset),
                origin + Vec3::new(extent, 0.0, offset),
            ),
            (
                origin + Vec3::new(offset, 0.0, -extent),
                origin + Vec3::new(offset, 0.0, extent),
            ),
        ] {
            lines.push(crate::gizmo_layout::GizmoLine {
                shape: crate::gizmo_layout::GizmoShape::Stroke,
                start,
                end,
                width_css: if index == 0 { 1.0 } else { 0.6 },
                handle: "",
                secondary: true,
                rear: false,
                visible: true,
            });
        }
    }
    lines
}
