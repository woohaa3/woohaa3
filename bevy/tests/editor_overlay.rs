//! CPU-only regression for the production overlay system, without browser plugins.
//! The domain adapters below provide only the state consumed by this system.
use bevy::prelude::*;

mod model3d {
    pub mod editor {
        pub const EDITOR_LAYER: usize = 1;
    }
    pub mod grid {
        #[derive(bevy::prelude::Component)]
        pub struct ModelCanvasCamera;
    }
}

#[derive(Resource, Default)]
struct CurrentScene(Scene);
#[derive(Default)]
struct Scene {
    model_focus: Option<()>,
}

#[path = "../src/app/editor_overlay.rs"]
mod editor_overlay;

mod tests {
    use super::*;
    use editor_overlay::{EditorOverlayCamera, setup, sync};
    use model3d::grid::ModelCanvasCamera;

    #[test]
    fn overlay_follows_focus_and_observer_lifecycle() {
        // 只执行 ECS 相机状态同步，不创建窗口或渲染设备。
        let mut app = App::new();
        app.init_resource::<CurrentScene>()
            .add_systems(Startup, setup)
            .add_systems(Update, sync);
        let pose = Transform::from_xyz(1.0, 2.0, 3.0);
        let observer = app
            .world_mut()
            .spawn((
                ModelCanvasCamera,
                Camera3d::default(),
                Camera {
                    viewport: Some(bevy::camera::Viewport {
                        physical_position: UVec2::new(20, 30),
                        physical_size: UVec2::new(800, 600),
                        ..default()
                    }),
                    ..default()
                },
                pose,
                Projection::Perspective(PerspectiveProjection::default()),
            ))
            .id();
        app.update();
        let overlay = app
            .world_mut()
            .query_filtered::<Entity, With<EditorOverlayCamera>>()
            .single(app.world())
            .unwrap();
        assert!(!app.world().get::<Camera>(overlay).unwrap().is_active);

        app.world_mut().resource_mut::<CurrentScene>().0.model_focus = Some(());
        app.update();
        let camera = app.world().get::<Camera>(overlay).unwrap();
        assert!(camera.is_active);
        assert_eq!(
            camera.viewport.as_ref().unwrap().physical_size,
            UVec2::new(800, 600)
        );
        assert_eq!(*app.world().get::<Transform>(overlay).unwrap(), pose);
        assert!(matches!(
            app.world().get::<Projection>(overlay).unwrap(),
            Projection::Perspective(_)
        ));

        app.world_mut()
            .get_mut::<Camera>(observer)
            .unwrap()
            .is_active = false;
        app.update();
        assert!(!app.world().get::<Camera>(overlay).unwrap().is_active);
        app.world_mut()
            .get_mut::<Camera>(observer)
            .unwrap()
            .is_active = true;
        app.update();
        assert!(app.world().get::<Camera>(overlay).unwrap().is_active);

        app.world_mut().resource_mut::<CurrentScene>().0.model_focus = None;
        app.update();
        assert!(!app.world().get::<Camera>(overlay).unwrap().is_active);
    }
}
