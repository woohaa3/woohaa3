//! Reusable disposable handles. The host owns tools, permissions, previews and commits.
use crate::gizmo_layout::render::{GizmoPalette, GizmoRenderAssets, sync_lines};
use crate::gizmo_layout::{GizmoView, ObjectGizmoLayout, ObjectTool};
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
    let layout = selection
        .mode
        .zip(selection.target)
        .zip(selection.view)
        .and_then(|((mode, target), view)| {
            let tool = match mode {
                TransformGizmoMode::Yaw => ObjectTool::Yaw,
                TransformGizmoMode::Scale => ObjectTool::Scale,
                _ => ObjectTool::Move,
            };
            ObjectGizmoLayout::new(&view, target.focus, tool, selection.basis)
                .map(|layout| (view, layout))
        });
    if let Some((view, layout)) = layout {
        let hover = selection.hover.clone();
        let active = selection.active.clone();
        sync_lines(
            &mut commands,
            &mut assets,
            &mut meshes,
            &mut selection.entities,
            TransformGizmoHandle,
            &layout.lines,
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
