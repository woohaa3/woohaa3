//! Shared lifecycle helpers for transient canvas overlay layers.
use bevy::prelude::*;

/// Return an existing marker entity or queue a new one. The caller may update the mesh in the
/// same command buffer; a newly spawned layer becomes queryable after the next deferred boundary.
pub(crate) fn find_or_spawn<M: Component + Default>(
    commands: &mut Commands,
    layers: &Query<Entity, With<M>>,
    mesh: Handle<Mesh>,
    material: Handle<ColorMaterial>,
) -> Entity {
    if let Some(entity) = layers.iter().next() {
        commands.entity(entity).insert((Mesh2d(mesh), MeshMaterial2d(material)));
        entity
    } else {
        commands
            .spawn((M::default(), Mesh2d(mesh), MeshMaterial2d(material)))
            .id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas_ecs::components::NodeActionLayer;

    #[test]
    fn layer_marker_is_stable_across_empty_content_cycles() {
        let mut app = App::new();
        app.add_systems(Update, |mut commands: Commands, layers: Query<Entity, With<NodeActionLayer>>, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<ColorMaterial>>| {
            let mesh = meshes.add(Mesh::from(Rectangle::new(1.0, 1.0)));
            let material = materials.add(ColorMaterial::default());
            let _ = find_or_spawn::<NodeActionLayer>(&mut commands, &layers, mesh, material);
        });
        app.init_resource::<Assets<Mesh>>();
        app.init_resource::<Assets<ColorMaterial>>();
        app.update();
        let first = {
            let world = app.world_mut();
            world.query_filtered::<Entity, With<NodeActionLayer>>().iter(world).next().unwrap()
        };
        app.update();
        let second = {
            let world = app.world_mut();
            world.query_filtered::<Entity, With<NodeActionLayer>>().iter(world).next().unwrap()
        };
        assert_eq!(first, second);
    }
}

