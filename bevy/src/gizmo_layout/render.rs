//! A single unit mesh and a fixed number of material slots; transforms never allocate assets.
use super::{GizmoLine, GizmoView};
use bevy::{camera::visibility::RenderLayers, prelude::*};

#[derive(Clone, Debug, Resource)]
pub struct GizmoPalette {
    pub colors: [Color; 5],
    pub accent: Color,
}
impl Default for GizmoPalette {
    fn default() -> Self {
        Self {
            colors: [Color::NONE; 5],
            accent: Color::NONE,
        }
    }
}

#[derive(Default, Resource)]
pub struct GizmoRenderAssets {
    mesh: Option<Handle<Mesh>>,
    materials: Vec<Handle<StandardMaterial>>,
}
impl GizmoRenderAssets {
    pub fn sync_palette(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        palette: &GizmoPalette,
    ) {
        for role in 0..6 {
            for weight in [1.0, 0.3, 0.16] {
                let mut color = if role < 5 {
                    palette.colors[role]
                } else {
                    palette.accent
                };
                color.set_alpha(color.alpha() * weight);
                let index = role * 3
                    + if weight == 1.0 {
                        0
                    } else if weight == 0.3 {
                        1
                    } else {
                        2
                    };
                if let Some(handle) = self.materials.get(index) {
                    if materials
                        .get(handle)
                        .is_some_and(|material| material.base_color != color)
                    {
                        if let Some(mut material) = materials.get_mut(handle) {
                            material.base_color = color;
                        }
                    }
                } else {
                    self.materials.push(materials.add(StandardMaterial {
                        base_color: color,
                        unlit: true,
                        alpha_mode: AlphaMode::Blend,
                        ..default()
                    }));
                }
            }
        }
    }
    pub fn mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.mesh
            .get_or_insert_with(|| meshes.add(Cuboid::new(1.0, 1.0, 1.0)))
            .clone()
    }
    pub fn material(
        &self,
        line: &GizmoLine,
        hover: Option<&str>,
        active: Option<&str>,
    ) -> Handle<StandardMaterial> {
        let selected = active.or(hover);
        let highlighted = selected == Some(line.handle)
            || line.handle == "shot-origin" && selected == Some("distance");
        let role = if highlighted {
            5
        } else {
            match line.handle {
                "x" => 0,
                "y" | "yaw-ring" => 1,
                "z" => 2,
                "center" | "scale" | "shot-origin" => 3,
                _ => 4,
            }
        };
        let weight = if line.rear {
            2
        } else if active.is_some() && !highlighted || line.secondary && !highlighted {
            1
        } else {
            0
        };
        self.materials[role * 3 + weight].clone()
    }
}

pub fn line_transform(line: &GizmoLine, view: &GizmoView, highlighted: bool) -> Option<Transform> {
    if !line.visible || view.project(line.start).is_none() || view.project(line.end).is_none() {
        return None;
    }
    let delta = line.end - line.start;
    let length = delta.length();
    if !length.is_finite() || length <= 1e-8 {
        return None;
    }
    let width = view.world_per_css((line.start + line.end) * 0.5)?
        * if highlighted { 2.25 } else { line.width_css };
    Some(Transform {
        translation: (line.start + line.end) * 0.5,
        rotation: Quat::from_rotation_arc(Vec3::Z, delta / length),
        scale: Vec3::new(width, width, length),
    })
}

pub fn sync_lines<M: Component + Clone>(
    commands: &mut Commands,
    assets: &mut GizmoRenderAssets,
    meshes: &mut Assets<Mesh>,
    entities: &mut Vec<Entity>,
    marker: M,
    lines: &[GizmoLine],
    view: &GizmoView,
    layers: RenderLayers,
    hover: Option<&str>,
    active: Option<&str>,
) {
    let mesh = assets.mesh(meshes);
    for (i, line) in lines.iter().enumerate() {
        let selected = active.or(hover);
        let highlighted = !line.handle.is_empty()
            && (selected == Some(line.handle)
                || line.handle == "shot-origin" && selected == Some("distance"));
        let transform = line_transform(line, view, highlighted);
        let values = (
            transform.unwrap_or_default(),
            if transform.is_some() {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            },
            MeshMaterial3d(assets.material(line, hover, active)),
        );
        if let Some(entity) = entities.get(i) {
            commands.entity(*entity).insert(values);
        } else {
            entities.push(
                commands
                    .spawn((marker.clone(), Mesh3d(mesh.clone()), values, layers.clone()))
                    .id(),
            );
        }
    }
    for entity in entities.drain(lines.len().min(entities.len())..) {
        commands.entity(entity).try_despawn();
    }
}
