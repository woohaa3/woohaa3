//! Pause canvas schedules and cameras while a native editor owns presentation.
use bevy::{
    app::{First, Last, MainScheduleOrder, PostUpdate, PreUpdate},
    ecs::schedule::{InternedScheduleLabel, ScheduleLabel},
    prelude::*,
};
use std::collections::HashMap;
#[derive(Component)]
pub(crate) struct EditorCamera;
#[derive(Resource, Default)]
struct Suspension {
    active: bool,
    schedules: Option<Vec<InternedScheduleLabel>>,
    cameras: HashMap<Entity, bool>,
}
pub(crate) fn install(app: &mut App) {
    app.init_resource::<Suspension>()
        .init_resource::<woohaa_bevy_canvas::canvas_activity::CanvasWorkSuspended>()
        .add_systems(Last, suspend_cameras);
}
pub(crate) fn set(app: &mut App, active: bool) {
    if !app.world().contains_resource::<Suspension>() {
        install(app);
    }
    let mut state = app.world_mut().remove_resource::<Suspension>().unwrap();
    if state.active != active {
        if active {
            let mut order = app.world_mut().resource_mut::<MainScheduleOrder>();
            state.schedules = Some(order.labels.clone());
            order.labels.retain(|label| {
                [
                    First.intern(),
                    PreUpdate.intern(),
                    PostUpdate.intern(),
                    Last.intern(),
                ]
                .contains(label)
            });
        } else {
            if let Some(labels) = state.schedules.take() {
                app.world_mut().resource_mut::<MainScheduleOrder>().labels = labels;
            }
            for (entity, original) in state.cameras.drain() {
                if let Some(mut camera) = app.world_mut().get_mut::<Camera>(entity) {
                    camera.is_active = original;
                }
            }
        }
        state.active = active;
        crate::shell_log::info(if active {
            "Native editor owns presentation: canvas schedules/cameras paused"
        } else {
            "Native editor released presentation: canvas schedules/cameras resumed"
        });
    }
    app.world_mut()
        .resource_mut::<woohaa_bevy_canvas::canvas_activity::CanvasWorkSuspended>()
        .0 = active;
    app.world_mut().insert_resource(state);
    for mut camera in app
        .world_mut()
        .query_filtered::<&mut Camera, With<EditorCamera>>()
        .iter_mut(app.world_mut())
    {
        if camera.is_active != active {
            camera.is_active = active;
        }
    }
    // Disable old cameras before this frame as well as cameras created during it.
    app.world_mut()
        .run_system_cached(suspend_cameras)
        .expect("camera suspension system");
}
fn suspend_cameras(
    mut state: ResMut<Suspension>,
    mut cameras: Query<(Entity, &mut Camera), Without<EditorCamera>>,
) {
    if !state.active {
        return;
    }
    state.cameras.retain(|entity, _| cameras.contains(*entity));
    for (entity, mut camera) in &mut cameras {
        state.cameras.entry(entity).or_insert(camera.is_active);
        if camera.is_active {
            camera.is_active = false;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Resource, Default)]
    struct Counts {
        canvas: usize,
        framework: usize,
        derived: usize,
    }
    #[test]
    fn editor_suspends_canvas_work_preserves_framework_and_restores_cameras() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        install(&mut app);
        app.init_resource::<Counts>()
            .add_systems(Update, |mut c: ResMut<Counts>| c.canvas += 1)
            .add_systems(PostUpdate, |mut c: ResMut<Counts>| c.framework += 1)
            .add_systems(
                PostUpdate,
                (|mut c: ResMut<Counts>| c.derived += 1)
                    .run_if(woohaa_bevy_canvas::canvas_activity::running),
            );
        let live = app.world_mut().spawn(Camera::default()).id();
        let hidden = app
            .world_mut()
            .spawn(Camera {
                is_active: false,
                ..default()
            })
            .id();
        let editor = app
            .world_mut()
            .spawn((
                Camera {
                    is_active: false,
                    ..default()
                },
                EditorCamera,
            ))
            .id();
        app.update();
        let original = app.world().resource::<MainScheduleOrder>().labels.clone();
        set(&mut app, true);
        app.update();
        app.update();
        assert_eq!(app.world().resource::<Counts>().canvas, 1);
        assert_eq!(app.world().resource::<Counts>().derived, 1);
        assert_eq!(app.world().resource::<Counts>().framework, 3);
        assert!(!app.world().get::<Camera>(live).unwrap().is_active);
        assert!(app.world().get::<Camera>(editor).unwrap().is_active);
        let late = app.world_mut().spawn(Camera::default()).id();
        app.update();
        assert!(!app.world().get::<Camera>(late).unwrap().is_active);
        set(&mut app, false);
        app.update();
        assert_eq!(app.world().resource::<Counts>().canvas, 2);
        assert_eq!(app.world().resource::<Counts>().derived, 2);
        assert!(app.world().get::<Camera>(live).unwrap().is_active);
        assert!(!app.world().get::<Camera>(hidden).unwrap().is_active);
        assert!(app.world().get::<Camera>(late).unwrap().is_active);
        assert_eq!(app.world().resource::<MainScheduleOrder>().labels, original);
    }
    #[test]
    fn editor_window_resize_keeps_origin_and_dpr_without_canvas_scene_update() {
        let mut app = App::new();
        app.add_message::<bevy::window::WindowResized>();
        let window = app
            .world_mut()
            .spawn((Window::default(), bevy::window::PrimaryWindow))
            .id();
        sync_window(
            &mut app,
            &crate::document_editor::EditorLayout {
                physical_size: [1600, 1000],
                scale_factor: 2.,
                layout_generation: 1,
                viewport_origin_css: [10., 40.],
            },
        );
        let w = app.world().get::<Window>(window).unwrap();
        assert_eq!([w.physical_width(), w.physical_height()], [1620, 1080]);
        assert_eq!(w.scale_factor(), 2.);
    }
}

/// The normal canvas surface sync is paused; keep editor projection/DPR current.
pub(crate) fn sync_window(app: &mut App, layout: &crate::document_editor::EditorLayout) {
    let size = [0, 1].map(|i| {
        (layout.physical_size[i] as f64
            + layout.viewport_origin_css[i].max(0.) * layout.scale_factor)
            .round()
            .max(1.) as u32
    });
    let mut changed = Vec::new();
    for (entity, mut window) in app
        .world_mut()
        .query_filtered::<(Entity, &mut Window), With<bevy::window::PrimaryWindow>>()
        .iter_mut(app.world_mut())
    {
        if window.physical_width() != size[0]
            || window.physical_height() != size[1]
            || (window.scale_factor() as f64 - layout.scale_factor).abs() > 0.0001
        {
            window
                .resolution
                .set_scale_factor_override(Some(layout.scale_factor as f32));
            window.resolution.set_physical_resolution(size[0], size[1]);
            changed.push(bevy::window::WindowResized {
                window: entity,
                width: window.width(),
                height: window.height(),
            });
        }
    }
    for event in changed {
        app.world_mut().write_message(event);
    }
}
