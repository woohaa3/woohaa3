//! 镜头卡片与 3D 机位之间的虚线贝塞尔连接（Bevy 2D）。
//!
//! 使用 2D 几何层绘制，与卡片/机位同一帧更新；z 略低于卡片，因此线从卡片底边露出，
//! 不会盖住卡片内容。只读 accepted scene：镜头拖动中的预览位姿和卡片位置预览已由
//! Render Scene 带下来，不需要第二套 DOM 覆盖层。

use bevy::camera::visibility::NoFrustumCulling;
use bevy::prelude::*;

use crate::app::CurrentScene;
use crate::isometric_grid::view_rotation;
use crate::protocol::world_to_renderer;
use crate::theme::ThemeResource;

use super::CanvasMaterials;
use super::geometry::Geometry;

const CONNECTOR_Z: f32 = 9.9;
const CONNECTOR_WIDTH: f32 = 1.5;
const CONNECTOR_ALPHA: f32 = 0.85;

#[derive(Component)]
pub(crate) struct WorldCameraConnectorLayer;

#[derive(Default)]
pub(crate) struct ConnectorState {
    key: Option<String>,
    mesh: Option<Handle<Mesh>>,
    entity: Option<Entity>,
}

pub(crate) fn sync(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    materials: Res<CanvasMaterials>,
    mut state: Local<ConnectorState>,
) {
    let key = presentation_key(&scene.0, &theme);
    if state.key.as_deref() == Some(key.as_str()) {
        return;
    }
    state.key = Some(key);
    let has_camera = scene.0.nodes.iter().any(|node| node.world_camera.is_some());
    let mut geometry = Geometry::default();
    if has_camera {
        let color = theme.token_u32("canvasPortDefault");
        for node in &scene.0.nodes {
            let Some(camera) = &node.world_camera else {
                continue;
            };
            let [x, y, z] =
                world_to_renderer([camera.position.u, camera.position.v, camera.position.h]);
            let projected = view_rotation() * Vec3::new(x as f32, y as f32, z as f32);
            let end = Vec2::new(projected.x, -projected.y);
            let start = Vec2::new(node.x + node.width / 2.0, node.y + node.height);
            let dy = end.y - start.y;
            let direction = if dy < 0.0 { -1.0 } else { 1.0 };
            let lift = (dy.abs() * 0.35).clamp(26.0, 96.0);
            let c1 = Vec2::new(start.x, start.y + direction * lift);
            let c2 = Vec2::new(end.x, end.y - direction * lift);
            geometry.curve_with_controls_alpha(
                start,
                c1,
                c2,
                end,
                CONNECTOR_WIDTH,
                CONNECTOR_Z,
                color,
                true,
                CONNECTOR_ALPHA,
            );
        }
    }
    let mesh = geometry.build();
    if let Some(handle) = &state.mesh {
        meshes.insert(handle.id(), mesh);
    } else {
        state.mesh = Some(meshes.add(mesh));
    }
    let handle = state.mesh.clone().expect("connector mesh");
    if let Some(entity) = state.entity {
        commands.entity(entity).insert((
            Mesh2d(handle),
            if has_camera {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            },
        ));
    } else {
        let entity = commands
            .spawn((
                WorldCameraConnectorLayer,
                Mesh2d(handle),
                MeshMaterial2d(materials.blend.clone()),
                Transform::default(),
                if has_camera {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
                NoFrustumCulling,
            ))
            .id();
        state.entity = Some(entity);
    }
}

fn presentation_key(scene: &crate::protocol::Scene, theme: &ThemeResource) -> String {
    let mut key = String::new();
    key.push_str(theme.fingerprint());
    for node in &scene.nodes {
        let Some(camera) = &node.world_camera else {
            continue;
        };
        let _ = std::fmt::Write::write_fmt(
            &mut key,
            format_args!(
                "{}:{:.4},{:.4},{:.4},{:.4};{:.4},{:.4},{:.4};{:.4},{:.4},{:.4},{:.4};",
                node.id,
                node.x,
                node.y,
                node.width,
                node.height,
                camera.position.u,
                camera.position.v,
                camera.position.h,
                camera.rotation[0],
                camera.rotation[1],
                camera.rotation[2],
                camera.rotation[3],
            ),
        );
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::sprite_render::AlphaMode2d;

    #[test]
    fn sync_builds_a_mesh_for_world_camera_cards() {
        let node = serde_json::json!({
            "id": "camera-node",
            "type": "node",
            "x": 100.0,
            "y": 200.0,
            "width": 248.0,
            "height": 156.0,
            "worldCamera": {
                "kind": "world-camera",
                "version": "shared-world-v1",
                "cameraId": "camera-1",
                "settingsVersion": "v1",
                "position": { "u": 9.0, "v": 9.0, "h": 5.0 },
                "rotation": [0.0, -0.229752920547361, 0.97324898946773, 0.0],
                "projection": {
                    "kind": "isometric",
                    "verticalSizeMeters": 8.0,
                    "nearMeters": 0.1,
                    "farMeters": 500.0
                },
                "captureMode": { "kind": "static" },
                "aspect": { "width": 16.0, "height": 9.0 },
                "boundInstanceId": null
            }
        });
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<ColorMaterial>>()
            .insert_resource(CurrentScene(crate::protocol::Scene {
                nodes: vec![serde_json::from_value(node).unwrap()],
                ..Default::default()
            }))
            .insert_resource(ThemeResource::default());
        let base_mesh = app
            .world_mut()
            .resource_mut::<Assets<Mesh>>()
            .add(Geometry::default().build());
        let blend = app
            .world_mut()
            .resource_mut::<Assets<ColorMaterial>>()
            .add(ColorMaterial {
                alpha_mode: AlphaMode2d::Blend,
                ..default()
            });
        app.insert_resource(CanvasMaterials {
            solid: blend.clone(),
            blend,
            font: default(),
        });
        let _ = base_mesh;
        app.add_systems(Update, sync);
        app.update();
        let meshes = app.world_mut().query::<&Mesh2d>().iter(app.world()).count();
        assert_eq!(meshes, 1);
        let handle = app
            .world_mut()
            .query::<&Mesh2d>()
            .iter(app.world())
            .next()
            .unwrap()
            .0
            .clone();
        assert!(
            app.world()
                .resource::<Assets<Mesh>>()
                .get(&handle)
                .is_some_and(|mesh| mesh.count_vertices() > 0)
        );
    }
}
