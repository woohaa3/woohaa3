use super::*;
use std::time::Duration;

fn app() -> App {
    let mut app = App::new();
    app.init_resource::<Time>()
        .init_resource::<CurrentScene>()
        .init_resource::<FocusRig>()
        .init_resource::<ModelVisuals>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<ThemeResource>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .init_resource::<Assets<RunMaterial>>()
        .init_resource::<RunEffects>()
        .init_resource::<RunEffectSettings>()
        .insert_resource(SurfaceState {
            size: Vec2::new(1024., 768.),
            pixel_ratio: 1.,
        })
        .add_systems(Update, sync);
    let mut state = app.world_mut().resource_mut::<CurrentScene>();
    state.0.nodes = serde_json::from_value(serde_json::json!([{
        "id":"film", "type":"model", "x":100, "y":100, "width":200, "height":140,
        "compositeAsset":{"x":100,"y":100,"width":200,"height":140},
        "aggregateRun":{"active":true}
    }]))
    .unwrap();
    state.0.run_feedback = serde_json::from_value(serde_json::json!([{
        "nodeId":"film","active":true,"operationKey":"operation","phase":"running","source":"agent","labelCode":"modifying"
    }])).unwrap();
    state.0.index_primitives();
    app
}

#[test]
fn stable_identity_does_not_upload_per_frame_and_layers_exclude_outputs() {
    let mut app = app();
    app.update();
    let start = app.world().resource::<RunEffects>().entries["film"].start;
    let uploads = app.world().resource::<RunEffects>().geometry_uploads;
    let mesh_count = app.world().resource::<Assets<Mesh>>().len();
    for _ in 0..8 {
        app.world_mut()
            .resource_mut::<Time>()
            .advance_by(Duration::from_millis(16));
        app.update();
    }
    assert_eq!(
        app.world().resource::<RunEffects>().geometry_uploads,
        uploads
    );
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), mesh_count);
    let entry = &app.world().resource::<RunEffects>().entries["film"];
    assert!(entry.entities.len() <= 2);
    for entity in &entry.entities {
        let layers = app.world().get::<RenderLayers>(*entity).unwrap();
        assert!(layers.intersects(&RenderLayers::layer(WORK_LAYER)));
        for excluded in [0, 7, 32, 40] {
            assert!(!layers.intersects(&RenderLayers::layer(excluded)));
        }
    }
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .run_feedback
        .as_mut()
        .unwrap()
        .phase = "committing".into();
    app.update();
    assert_eq!(
        app.world().resource::<RunEffects>().entries["film"].start,
        start
    );
    assert_eq!(
        app.world().resource::<RunEffects>().geometry_uploads,
        uploads
    );
}

#[test]
fn verifying_stops_scan_and_terminal_then_deletion_reclaims_every_asset() {
    let mut app = app();
    app.update();
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .run_feedback
        .as_mut()
        .unwrap()
        .phase = "verifying".into();
    app.update();
    assert!(app.world().resource::<Assets<RunMaterial>>().is_empty());
    assert_eq!(
        app.world().resource::<RunEffects>().entries["film"]
            .entities
            .len(),
        1
    );
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].aggregate_run = None;
    app.update();
    app.world_mut()
        .resource_mut::<Time>()
        .advance_by(Duration::from_millis(181));
    app.update();
    assert!(app.world().resource::<RunEffects>().entries.is_empty());
    assert!(app.world().resource::<Assets<Mesh>>().is_empty());
    assert!(
        app.world()
            .resource::<Assets<StandardMaterial>>()
            .is_empty()
    );
    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .nodes
        .clear();
    let uploads = app.world().resource::<RunEffects>().geometry_uploads;
    app.update();
    app.update();
    assert_eq!(
        app.world().resource::<RunEffects>().geometry_uploads,
        uploads
    );
}

#[test]
fn hidden_and_focus_only_submit_current_owner_and_resume_phase() {
    let mut app = app();
    app.update();
    let start = app.world().resource::<RunEffects>().entries["film"].start;
    app.world_mut().resource_mut::<RunEffectSettings>().enabled = false;
    app.update();
    assert!(app.world().resource::<Assets<Mesh>>().is_empty());
    app.world_mut().resource_mut::<RunEffectSettings>().enabled = true;
    app.world_mut().resource_mut::<FocusRig>().focus_node = Some("film".into());
    app.update();
    assert_eq!(
        app.world().resource::<RunEffects>().entries["film"].start,
        start
    );
    app.world_mut().resource_mut::<FocusRig>().focus_node = Some("other".into());
    app.update();
    assert!(app.world().resource::<Assets<Mesh>>().is_empty());
    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .nodes
        .clear();
    app.update();
    assert!(app.world().resource::<Assets<Mesh>>().is_empty());
}

#[test]
fn focus_camera_changes_refresh_geometry_without_restarting_operation() {
    let mut app = app();
    app.world_mut().resource_mut::<FocusRig>().focus_node = Some("film".into());
    let camera = app
        .world_mut()
        .spawn((
            Camera::default(),
            ModelCanvasCamera,
            GlobalTransform::IDENTITY,
        ))
        .id();
    app.update();
    let start = app.world().resource::<RunEffects>().entries["film"].start;
    let uploads = app.world().resource::<RunEffects>().geometry_uploads;
    app.world_mut()
        .entity_mut(camera)
        .insert(GlobalTransform::from(Transform::from_rotation(
            Quat::from_rotation_y(0.4),
        )));
    app.update();
    assert!(app.world().resource::<RunEffects>().geometry_uploads > uploads);
    assert_eq!(
        app.world().resource::<RunEffects>().entries["film"].start,
        start
    );
}
