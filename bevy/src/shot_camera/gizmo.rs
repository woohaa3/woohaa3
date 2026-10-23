//! Host-driven disposable rig helpers. Shared screen layout is also the picking geometry.
use super::components::{ShotCameraDerived, ShotCameraEditable, ShotCameraLens};
use super::{GizmoPart, GizmoPartKind};
use crate::gizmo_layout::render::{GizmoPalette, GizmoRenderAssets, sync_lines};
use crate::gizmo_layout::{GizmoView, shot_gizmo_layout};
use bevy::{camera::visibility::RenderLayers, prelude::*};
pub const SHOT_GIZMO_LAYER: usize = 1;
pub const SHOT_ELEVATION_ARC_SEGMENTS: u32 = 32;
#[derive(Resource, Default)]
pub struct ShotGizmoAssets {
    render: GizmoRenderAssets,
}
#[derive(Resource, Default, Debug)]
pub struct ShotGizmoSelection {
    pub entities: Vec<Entity>,
    pub view: Option<GizmoView>,
    pub palette: GizmoPalette,
    pub tool: String,
    pub hover: Option<String>,
    pub active: Option<String>,
}
pub(crate) fn sync_shot_gizmos(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut assets: ResMut<ShotGizmoAssets>,
    selected: Res<ShotGizmoSelection>,
    mut rigs: Query<(
        Entity,
        &ShotCameraDerived,
        &ShotCameraLens,
        &ShotCameraEditable,
        &mut super::ShotCameraInner,
    )>,
) {
    assets
        .render
        .sync_palette(&mut materials, &selected.palette);
    for (entity, derived, lens, editable, mut inner) in &mut rigs {
        let view = selected
            .view
            .filter(|_| editable.enabled && selected.entities.contains(&entity));
        let Some(view) = view else {
            for part in inner.gizmo.entities.drain(..) {
                commands.entity(part.entity).try_despawn();
            }
            continue;
        };
        let lines = shot_gizmo_layout(
            &view,
            derived.focus,
            derived.position,
            derived.fov,
            lens.aspect,
            &selected.tool,
        );
        let mut entities = inner.gizmo.entities.iter().map(|p| p.entity).collect();
        sync_lines(
            &mut commands,
            &mut assets.render,
            &mut meshes,
            &mut entities,
            super::ShotGizmo { rig: entity },
            &lines,
            &view,
            RenderLayers::layer(SHOT_GIZMO_LAYER),
            selected.hover.as_deref(),
            selected.active.as_deref(),
        );
        inner.gizmo.entities = entities
            .into_iter()
            .zip(lines)
            .map(|(entity, line)| GizmoPart {
                entity,
                kind: GizmoPartKind::Line {
                    start: line.start,
                    end: line.end,
                    width: line.width_css,
                },
            })
            .collect();
    }
}
pub(crate) fn cleanup_orphan_shot_gizmos(
    mut commands: Commands,
    gizmos: Query<(Entity, &super::ShotGizmo)>,
    previews: Query<(Entity, &super::ShotPreviewCamera)>,
) {
    for (entity, gizmo) in &gizmos {
        if commands.get_entity(gizmo.rig).is_err() {
            commands.entity(entity).try_despawn();
        }
    }
    for (entity, preview) in &previews {
        if commands.get_entity(preview.rig).is_err() {
            commands.entity(entity).try_despawn();
        }
    }
}
