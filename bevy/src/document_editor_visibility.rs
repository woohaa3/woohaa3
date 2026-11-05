//! Suppress the old source node while a shared editor viewport is presented.
//! Otherwise erased/semitransparent pixels would blend over stale source pixels.
use crate::canvas_ecs::components::{CanvasNodeId, CanvasTextureSprite};
use bevy::prelude::*;
use std::collections::HashMap;
#[derive(Resource, Default)]
pub struct NativeEditorTarget(pub Option<String>);
pub fn install(app: &mut App) {
    app.init_resource::<NativeEditorTarget>().add_systems(
        PostUpdate,
        sync.before(bevy::camera::visibility::VisibilitySystems::VisibilityPropagate).run_if(crate::canvas_activity::running),
    );
}
fn sync(
    target: Res<NativeEditorTarget>,
    mut previous: Local<HashMap<Entity, Visibility>>,
    mut nodes: Query<
        (
            Entity,
            Option<&CanvasNodeId>,
            Option<&CanvasTextureSprite>,
            &mut Visibility,
        ),
        Or<(With<CanvasNodeId>, With<CanvasTextureSprite>)>,
    >,
) {
    if target.0.is_none() && previous.is_empty() {
        return;
    }
    previous.retain(|entity, _| nodes.contains(*entity));
    for (entity, id, sprite, mut visibility) in &mut nodes {
        // Texture sprites use absolute transforms and are not children of owner.
        // Suppress the actual image as well as its semantic owner.
        let node_id = id
            .map(|id| id.0.as_str())
            .or_else(|| sprite.map(|sprite| sprite.node_id.as_str()));
        if target.0.is_some() && target.0.as_deref() == node_id {
            previous.entry(entity).or_insert(*visibility);
            *visibility = Visibility::Hidden;
        } else if let Some(original) = previous.remove(&entity) {
            // Preserve a newer scene decision when it has already replaced our hide.
            if *visibility == Visibility::Hidden {
                *visibility = original;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_is_hidden_only_while_shared_viewport_owns_it() {
        let mut app = App::new();
        install(&mut app);
        let visible = app
            .world_mut()
            .spawn((CanvasNodeId("image".into()), Visibility::Inherited))
            .id();
        let sprite = app
            .world_mut()
            .spawn((
                crate::canvas_ecs::components::CanvasTextureSprite {
                    owner: visible,
                    node_id: "image".into(),
                    content_id: None,
                },
                Visibility::Inherited,
            ))
            .id();
        let hidden = app
            .world_mut()
            .spawn((CanvasNodeId("already-hidden".into()), Visibility::Hidden))
            .id();
        app.world_mut().resource_mut::<NativeEditorTarget>().0 = Some("image".into());
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(visible).unwrap(),
            Visibility::Hidden
        );
        assert_eq!(
            *app.world().get::<Visibility>(sprite).unwrap(),
            Visibility::Hidden,
            "source Sprite is not parented to the node owner"
        );
        app.world_mut().resource_mut::<NativeEditorTarget>().0 = Some("already-hidden".into());
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(visible).unwrap(),
            Visibility::Inherited
        );
        assert_eq!(
            *app.world().get::<Visibility>(sprite).unwrap(),
            Visibility::Inherited
        );
        app.world_mut().resource_mut::<NativeEditorTarget>().0 = None;
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(hidden).unwrap(),
            Visibility::Hidden
        );
    }
}
