//! Three reusable primitive meshes and a fixed number of material slots; transforms never allocate assets.
use super::{GizmoLine, GizmoShape, GizmoView};
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
    meshes: Vec<Handle<Mesh>>,
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
    pub fn mesh(&mut self, meshes: &mut Assets<Mesh>, shape: GizmoShape) -> Handle<Mesh> {
        if self.meshes.is_empty() {
            self.meshes
                .push(meshes.add(Cylinder::new(0.5, 1.0).mesh().resolution(12)));
            self.meshes
                .push(meshes.add(Cone::new(0.5, 1.0).mesh().resolution(16)));
            self.meshes.push(meshes.add(Cuboid::new(1.0, 1.0, 1.0)));
        }
        self.meshes[match shape {
            GizmoShape::Stroke => 0,
            GizmoShape::Cone => 1,
            GizmoShape::Cube => 2,
        }]
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
                "x" | "elevation-ring" => 0,
                "y" | "yaw-ring" | "orbit-ring" => 1,
                "z" | "distance" => 2,
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
        * if highlighted {
            (line.width_css * 1.25).max(3.0)
        } else {
            line.width_css
        };
    Some(Transform {
        translation: (line.start + line.end) * 0.5,
        rotation: Quat::from_rotation_arc(Vec3::Y, delta / length),
        scale: Vec3::new(width, length, width),
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
    for (i, line) in lines.iter().enumerate() {
        let mesh = assets.mesh(meshes, line.shape);
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
            commands.entity(*entity).insert((Mesh3d(mesh), values));
        } else {
            entities.push(
                commands
                    .spawn((marker.clone(), bevy::light::NotShadowCaster, Mesh3d(mesh.clone()), values, layers.clone()))
                    .id(),
            );
        }
    }
    for entity in entities.drain(lines.len().min(entities.len())..) {
        commands.entity(entity).try_despawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;

    #[derive(Clone, Component)]
    struct TestHandle;

    #[derive(Resource)]
    struct TestLayout {
        lines: Vec<GizmoLine>,
        entities: Vec<Entity>,
        view: GizmoView,
    }

    fn sync_test(
        mut commands: Commands,
        mut assets: ResMut<GizmoRenderAssets>,
        mut meshes: ResMut<Assets<Mesh>>,
        mut layout: ResMut<TestLayout>,
    ) {
        let TestLayout {
            lines,
            entities,
            view,
        } = &mut *layout;
        sync_lines(
            &mut commands,
            &mut assets,
            &mut meshes,
            entities,
            TestHandle,
            lines,
            view,
            RenderLayers::layer(0),
            None,
            None,
        );
    }

    #[test]
    fn tool_changes_replace_reused_entity_mesh_without_allocating_more_assets() {
        let mut world = World::new();
        let mut assets = GizmoRenderAssets::default();
        let mut materials = Assets::<StandardMaterial>::default();
        assets.sync_palette(&mut materials, &GizmoPalette::default());
        world.insert_resource(assets);
        world.insert_resource(Assets::<Mesh>::default());
        world.insert_resource(TestLayout {
            lines: vec![GizmoLine {
                shape: GizmoShape::Cone,
                start: Vec3::ZERO,
                end: Vec3::Y,
                width_css: 11.0,
                handle: "y",
                secondary: false,
                rear: false,
                visible: true,
            }],
            entities: vec![],
            view: GizmoView::orbit(Vec3::ZERO, 0.6, -0.4, 10.0, Vec2::new(1200.0, 800.0), 1.0)
                .unwrap(),
        });
        world.run_system_once(sync_test).unwrap();
        let entity = world.resource::<TestLayout>().entities[0];
        let cone = world.get::<Mesh3d>(entity).unwrap().0.clone();
        for shape in [GizmoShape::Cube, GizmoShape::Stroke, GizmoShape::Cone] {
            world.resource_mut::<TestLayout>().lines[0].shape = shape;
            world.run_system_once(sync_test).unwrap();
            assert_eq!(world.resource::<TestLayout>().entities, vec![entity]);
            assert_eq!(world.resource::<Assets<Mesh>>().len(), 3);
            let current = &world.get::<Mesh3d>(entity).unwrap().0;
            assert_eq!(current == &cone, shape == GizmoShape::Cone);
        }
    }

}
