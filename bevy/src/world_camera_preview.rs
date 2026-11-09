//! Live world-camera view on the camera's own 2D card.
//!
//! Each world camera owns a `Camera3d` writing into an `Image`, and a 2D sprite placed in
//! the card content rect. Editing flies from the canvas observer into this lens and
//! adds a horizontal ground grid and scene-area guides on a separate editor layer.
//!
//! This is a *presentation* of the canonical camera pose; it does not capture pixels into
//! media, does not create history, and does not run generation. The later T09 capture
//! producer can reuse the same pose/projection math.

use std::collections::{HashMap, HashSet};

use bevy::{
    asset::RenderAssetUsages,
    camera::{RenderTarget, visibility::RenderLayers},
    image::ImageSampler,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
};

use crate::{
    app::{CurrentScene, PreviewLayerPool, SurfaceState},
    canvas_query::layout,
    model3d::ModelVisuals,
    protocol::{Scene, WorldCamera, world_rotation_to_renderer, world_to_renderer},
    theme::ThemeResource,
    world_camera_binding::{BindingResolution, WorldCameraBinding},
};

mod ground_grid;
mod transition;

/// Ground guides in editing, excluded from ordinary camera cards/captures.
pub(crate) const EDITOR_GUIDE_LAYER: usize = 9;

const MAX_PREVIEW_EDGE: f32 = 1024.0;
const PREVIEW_BUCKET: f32 = 64.0;
/// Inset from the card content rect so the rounded content corners stay visible.
const PREVIEW_INSET: f32 = 4.0;

#[derive(Resource, Default)]
pub(crate) struct WorldCameraPreviews {
    cards: HashMap<String, PreviewCard>,
    editor_backdrop: Option<Entity>,
    entry: Option<transition::EntryFlight>,
    ground: ground_grid::GroundGrid,
    /// Images replaced/removed last frame; dropped after the sprite commands applied.
    retired: Vec<Handle<Image>>,
}

struct PreviewCard {
    camera: Entity,
    sprite: Entity,
    image: Handle<Image>,
    size: UVec2,
    signature: String,
}

/// Frame every world-camera card once per scene/resize change.
pub(crate) fn sync(
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    theme: Res<ThemeResource>,
    mut previews: ResMut<WorldCameraPreviews>,
    mut bindings: ResMut<WorldCameraBinding>,
    mut pool: ResMut<PreviewLayerPool>,
    models: Res<ModelVisuals>,
    capture: Res<crate::world_capture::ActiveWorldCapture>,
    time: Option<Res<Time<Real>>>,
    observer: Query<(&Transform, &Projection), With<crate::model3d::grid::ModelCanvasCamera>>,
    mut grids: Query<&mut RenderLayers, With<crate::isometric_grid::IsometricGrid>>,
) {
    for handle in previews.retired.drain(..) {
        images.remove(handle.id());
    }
    let focus_active = scene.0.model_focus.is_some()
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some();
    let edit = scene.0.world_camera_edit.as_ref();
    let zoom = scene.0.viewport.zoom;
    let now = time.as_ref().map_or(0.0, |time| time.elapsed_secs_f64());
    if let Some(edit) = edit {
        if previews
            .entry
            .as_ref()
            .is_none_or(|entry| entry.node_id != edit.node_id)
        {
            let view = crate::model3d::grid::scene_view(&scene.0);
            let (transform, projection) = observer
                .single()
                .map(|(pose, lens)| (*pose, lens.clone()))
                .unwrap_or_else(|_| {
                    (
                        crate::isometric_grid::canvas_camera_transform_for_view(
                            surface.size,
                            &view,
                        ),
                        Projection::Orthographic(
                            crate::isometric_grid::canvas_camera_projection_for_view(&view),
                        ),
                    )
                });
            previews.entry = Some(transition::EntryFlight {
                node_id: edit.node_id.clone(),
                started: now,
                transform,
                projection,
                surface: surface.size,
            });
        }
    } else {
        previews.entry = None;
        previews
            .ground
            .clear(&mut commands, &mut meshes, &mut materials);
    }
    // The ordinary grid is a distant screen backdrop, so it belongs only to
    // the canvas observer while flying. The editing lens gets a real ground grid.
    for mut layers in &mut grids {
        *layers = RenderLayers::layer(if edit.is_some() {
            crate::world_camera::WORLD_CAMERA_GIZMO_LAYER
        } else {
            crate::preview_layers::GRID_LAYER
        });
    }
    if edit.is_some() {
        let entity = *previews
            .editor_backdrop
            .get_or_insert_with(|| commands.spawn_empty().id());
        commands.entity(entity).insert((
            Sprite::from_color(theme.backdrop_color(), surface.size / zoom),
            Transform::from_xyz(
                (surface.size.x / 2.0 - scene.0.viewport.x) / zoom,
                -(surface.size.y / 2.0 - scene.0.viewport.y) / zoom,
                900.0,
            ),
        ));
    } else if let Some(entity) = previews.editor_backdrop.take() {
        commands.entity(entity).try_despawn();
    }
    let mut live = HashSet::new();
    let mut keep: HashSet<String> = HashSet::new();
    for (index, node) in scene.0.nodes.iter().enumerate() {
        let Some(canonical) = &node.world_camera else {
            continue;
        };
        let editing = edit.is_some_and(|edit| edit.node_id == node.id);
        let camera = if editing {
            &edit.expect("editing camera").camera
        } else {
            canonical
        };
        live.insert(node.id.clone());
        // 单实例绑定：三处相机输出（卡片、编辑预览、捕获）共用同一解析规则。缺目标渲染空层，
        // 绝不退回整层 0；未绑定仍是全世界。
        let resolution =
            bindings.resolve(&scene.0, &mut pool, camera.bound_instance_id.as_deref());
        if let (Some(instance_id), BindingResolution::Instance { node_id, layer }) =
            (camera.bound_instance_id.as_deref(), &resolution)
        {
            keep.insert(instance_id.to_owned());
            crate::model3d::set_bound_instance_layer(&models, &mut commands, node_id, Some(*layer));
        }
        let (cx, cy, cw, ch) = layout::content_rect(node);
        if cw <= PREVIEW_INSET * 2.0 + 1.0 || ch <= PREVIEW_INSET * 2.0 + 1.0 {
            continue;
        }
        let aspect = (camera.aspect.width / camera.aspect.height) as f32;
        if !aspect.is_finite() || aspect <= 0.0 {
            continue;
        }
        let card_rect = fit_aspect(
            cx + PREVIEW_INSET,
            cy + PREVIEW_INSET,
            cw - PREVIEW_INSET * 2.0,
            ch - PREVIEW_INSET * 2.0,
            aspect,
        );
        // Render the same lens into the work area, leaving room for the compact HUD.
        // The canvas viewport itself is never changed, so exiting restores it exactly.
        let destination = editor_rect(surface.size, aspect);
        let amount = if time.is_none() {
            1.0
        } else {
            previews
                .entry
                .as_ref()
                .map_or(1.0, |entry| entry.amount(now))
        };
        let display = if editing {
            previews.entry.as_ref().expect("entry flight").rect(
                Vec4::new(destination.0, destination.1, destination.2, destination.3),
                amount,
            )
        } else {
            Vec4::ZERO
        };
        let (dx, dy, dw, dh) = if editing {
            (
                (display.x - scene.0.viewport.x) / zoom,
                (display.y - scene.0.viewport.y) / zoom,
                display.z / zoom,
                display.w / zoom,
            )
        } else {
            card_rect
        };
        let zoom = scene.0.viewport.zoom;
        let pixel_ratio = surface.pixel_ratio;
        let target = if editing {
            target_size_with_limit(
                destination.2,
                destination.3,
                aspect,
                1.0,
                pixel_ratio,
                2048.0,
            )
        } else {
            target_size(dw, dh, aspect, zoom, pixel_ratio)
        };
        let on_screen = card_on_screen(node, &scene.0, surface.size);
        // 已录制视频帧由卡片纹理呈现；编辑仍使用同一实时取景相机。
        let active = !focus_active && (editing || (edit.is_none() && on_screen && !node.texture));
        let signature = format!(
            "{}:{editing}:{dx}:{dy}:{dw}:{dh}:{}:{}",
            signature(camera, node, index, zoom, pixel_ratio, &theme, active),
            if editing { amount } else { 1.0 },
            edit.is_none_or(|edit| edit.show_helpers)
        );
        let mut pose = camera_transform(camera);
        let mut lens = camera_projection(camera, target);
        if editing {
            let entry = previews.entry.as_ref().expect("entry flight");
            if amount < 1.0 {
                pose = entry.pose(pose, amount);
                let height = match camera.projection {
                    crate::protocol::WorldCameraProjection::Isometric {
                        vertical_size_meters,
                        ..
                    } => vertical_size_meters,
                    _ => camera.position.h.abs().max(1.0) * 2.0,
                } * crate::protocol::UNITS_PER_METER;
                lens = entry.lens(lens, display, amount, zoom, height as f32);
            }
            let mut grid_lens = lens.clone();
            grid_lens.update(target.x as f32, target.y as f32);
            previews.ground.sync(
                &mut commands,
                &mut meshes,
                &mut materials,
                pose,
                &grid_lens,
                (camera.projection.far() * crate::protocol::UNITS_PER_METER) as f32,
                &theme,
            );
        }
        let existing = previews.cards.get(&node.id);
        if existing.is_some_and(|card| card.signature == signature) {
            continue;
        }
        let clear = theme.backdrop_color();
        let resize = existing.is_none_or(|card| card.size != target);
        let image = if resize {
            images.add(make_image(target))
        } else {
            existing.expect("existing card").image.clone()
        };
        let (camera_entity, sprite_entity) = match existing {
            Some(card) => (card.camera, card.sprite),
            None => {
                let camera_entity = commands
                    .spawn((
                        Camera3d::default(),
                        crate::model3d::shadows::camera_lighting(),
                        Camera {
                            order: -10,
                            is_active: false,
                            clear_color: ClearColorConfig::Custom(clear),
                            ..default()
                        },
                        RenderTarget::Image(image.clone().into()),
                        Transform::default(),
                        Projection::Perspective(PerspectiveProjection::default()),
                        RenderLayers::layer(0),
                        Msaa::Sample4,
                        bevy::render::view::Tonemapping::None,
                        bevy::render::view::DebandDither::Disabled,
                        bevy::render::view::NoIndirectDrawing,
                    ))
                    .id();
                let sprite_entity = commands
                    .spawn((
                        Sprite {
                            image: image.clone(),
                            custom_size: Some(Vec2::new(dw, dh)),
                            ..default()
                        },
                        Transform::from_xyz(
                            dx + dw / 2.0,
                            -dy - dh / 2.0,
                            10.01 + index as f32 * 0.1,
                        ),
                    ))
                    .id();
                (camera_entity, sprite_entity)
            }
        };
        if resize {
            commands
                .entity(camera_entity)
                .insert(RenderTarget::Image(image.clone().into()));
            let old = existing.map(|card| card.image.clone());
            commands.entity(sprite_entity).insert(Sprite {
                image: image.clone(),
                custom_size: Some(Vec2::new(dw, dh)),
                ..default()
            });
            if let Some(old) = old {
                previews.retired.push(old);
            }
        }
        commands.entity(camera_entity).insert((
            pose,
            lens,
            crate::world_camera_binding::camera_layers(&resolution, editing && edit.is_some_and(|edit| edit.show_helpers)),
            Camera {
                order: -10,
                is_active: active,
                clear_color: ClearColorConfig::Custom(clear),
                ..default()
            },
            Visibility::Inherited,
        ));
        commands.entity(sprite_entity).insert((
            Sprite {
                image: image.clone(),
                custom_size: Some(Vec2::new(dw, dh)),
                ..default()
            },
            Transform::from_xyz(
                dx + dw / 2.0,
                -dy - dh / 2.0,
                if editing {
                    901.0
                } else {
                    10.01 + index as f32 * 0.1
                },
            ),
            if active {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            },
        ));
        previews.cards.insert(
            node.id.clone(),
            PreviewCard {
                camera: camera_entity,
                sprite: sprite_entity,
                image,
                size: target,
                signature,
            },
        );
    }
    // 正在飞行的捕获持有其绑定层：即使没有镜头卡片引用该实例，也不能在稳定帧中途回收。
    if let Some(instance_id) = capture.pending_binding() {
        keep.insert(instance_id.to_owned());
    }
    bindings.retain(&scene.0, &models, &mut commands, &mut pool, &keep);
    // Remove cards whose node disappeared (or became a non-camera).
    let stale: Vec<String> = previews
        .cards
        .keys()
        .filter(|id| !live.contains(*id))
        .cloned()
        .collect();
    for id in stale {
        if let Some(card) = previews.cards.remove(&id) {
            commands.entity(card.camera).try_despawn();
            commands.entity(card.sprite).try_despawn();
            previews.retired.push(card.image);
        }
    }
}

fn card_on_screen(node: &crate::protocol::GraphNode, scene: &Scene, surface: Vec2) -> bool {
    let zoom = scene.viewport.zoom;
    let x = node.x * zoom + scene.viewport.x;
    let y = node.y * zoom + scene.viewport.y;
    let right = x + node.width * zoom;
    let bottom = y + node.height * zoom;
    right > 0.0 && x < surface.x && bottom > 0.0 && y < surface.y
}

pub(crate) fn editor_rect(surface: Vec2, aspect: f32) -> (f32, f32, f32, f32) {
    fit_aspect(24.0, 68.0, (surface.x - 48.0).max(1.0), (surface.y - 224.0).max(1.0), aspect)
}

fn fit_aspect(x: f32, y: f32, width: f32, height: f32, aspect: f32) -> (f32, f32, f32, f32) {
    let mut w = width;
    let mut h = width / aspect;
    if h > height {
        h = height;
        w = height * aspect;
    }
    (x + (width - w) / 2.0, y + (height - h) / 2.0, w, h)
}

fn target_size(width: f32, height: f32, aspect: f32, zoom: f32, pixel_ratio: f32) -> UVec2 {
    target_size_with_limit(width, height, aspect, zoom, pixel_ratio, MAX_PREVIEW_EDGE)
}

fn target_size_with_limit(
    width: f32,
    height: f32,
    aspect: f32,
    zoom: f32,
    pixel_ratio: f32,
    max_edge: f32,
) -> UVec2 {
    let positive = |value: f32| {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            1.0
        }
    };
    let scale = positive(zoom) * positive(pixel_ratio);
    let mut w = positive(width) * scale;
    let mut h = positive(height) * scale;
    let max = w.max(h);
    if max > max_edge {
        let factor = max_edge / max;
        w *= factor;
        h *= factor;
    }
    let bucket = |value: f32| {
        ((value / PREVIEW_BUCKET).ceil() * PREVIEW_BUCKET).clamp(32.0, max_edge) as u32
    };
    // Keep the render-target aspect equal to the camera aspect; otherwise a perspective
    // preview would be stretched by the card's on-screen rectangle.
    if w >= h {
        let bw = bucket(w);
        let bh = ((bw as f32 / aspect).round() as u32).clamp(32, max_edge as u32);
        UVec2::new(bw, bh)
    } else {
        let bh = bucket(h);
        let bw = ((bh as f32 * aspect).round() as u32).clamp(32, max_edge as u32);
        UVec2::new(bw, bh)
    }
}

fn make_image(size: UVec2) -> Image {
    let mut image = Image::new_uninit(
        Extent3d {
            width: size.x.max(1),
            height: size.y.max(1),
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::default(),
    );
    image.texture_descriptor.usage |=
        TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    image.sampler = ImageSampler::linear();
    image
}

fn camera_transform(camera: &WorldCamera) -> Transform {
    crate::world_camera_view::pose(camera)
}

fn camera_projection(camera: &WorldCamera, size: UVec2) -> Projection {
    crate::world_camera_view::projection(camera, size)
}

fn signature(
    camera: &WorldCamera,
    node: &crate::protocol::GraphNode,
    index: usize,
    zoom: f32,
    pixel_ratio: f32,
    theme: &ThemeResource,
    active: bool,
) -> String {
    format!(
        "{:.4},{:.4},{:.4}/{:.4},{:.4},{:.4},{:.4}/{:?}/{}x{}@{}x{}x{}x{}:{}:{}:{}",
        camera.position.u,
        camera.position.v,
        camera.position.h,
        camera.rotation[0],
        camera.rotation[1],
        camera.rotation[2],
        camera.rotation[3],
        camera.projection,
        camera.aspect.width,
        camera.aspect.height,
        node.x,
        node.y,
        node.width,
        node.height,
        zoom,
        pixel_ratio,
        index,
    ) + theme.fingerprint()
        + if active { "a" } else { "i" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_aspect_letterboxes_without_stretching_the_camera_image() {
        let (x, y, w, h) = fit_aspect(10.0, 20.0, 200.0, 100.0, 16.0 / 9.0);
        assert!((w / h - 16.0 / 9.0).abs() < 1e-4);
        assert!((x - (10.0 + (200.0 - w) / 2.0)).abs() < 1e-4);
        assert!((y - 20.0).abs() < 1e-4);
        assert!(w <= 200.0 && h <= 100.0);
    }

    #[test]
    fn target_size_preserves_the_camera_aspect_after_bucketing() {
        let size = target_size(320.0, 180.0, 16.0 / 9.0, 1.0, 2.0);
        assert!((size.x as f32 / size.y as f32 - 16.0 / 9.0).abs() < 0.02);
        assert!(size.x <= MAX_PREVIEW_EDGE as u32 && size.y <= MAX_PREVIEW_EDGE as u32);
    }

    #[test]
    fn sync_spawns_a_preview_camera_and_card_sprite() {
        let camera = serde_json::json!({
            "id": "camera-node",
            "type": "node",
            "x": 100.0,
            "y": 120.0,
            "width": 248.0,
            "height": 156.0,
            "worldCamera": {
                "kind": "world-camera",
                "version": "shared-world-v1",
                "cameraId": "camera-1",
                "settingsVersion": "v1",
                "position": { "u": 0.0, "v": 0.0, "h": 6.928203230275509 },
                "rotation": [
                    -0.27984814233312133,
                    -0.11591689595929515,
                    0.3647051996310009,
                    0.8804762392171493
                ],
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
        let node = serde_json::from_value(camera.clone()).unwrap();
        let scene = Scene {
            nodes: vec![node],
            ..Scene::default()
        };
        let mut app = App::new();
        app.init_resource::<Assets<Image>>()
            .init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<crate::app::PreviewLayerPool>()
            .init_resource::<crate::world_camera_binding::WorldCameraBinding>()
            .init_resource::<crate::world_capture::ActiveWorldCapture>()
            .init_resource::<crate::model3d::ModelVisuals>()
            .insert_resource(CurrentScene(scene))
            .insert_resource(SurfaceState {
                size: Vec2::new(800.0, 600.0),
                pixel_ratio: 1.0,
            })
            .insert_resource(ThemeResource::default())
            .init_resource::<WorldCameraPreviews>()
            .add_systems(Update, sync);
        let backdrop_grid = app
            .world_mut()
            .spawn((crate::isometric_grid::IsometricGrid, RenderLayers::layer(0)))
            .id();
        app.update();
        let cameras = app
            .world_mut()
            .query::<&Camera3d>()
            .iter(app.world())
            .count();
        let sprites = app.world_mut().query::<&Sprite>().iter(app.world()).count();
        assert_eq!(cameras, 1);
        assert_eq!(sprites, 1);

        let preview_camera =
            app.world().resource::<WorldCameraPreviews>().cards["camera-node"].camera;
        let preview_sprite =
            app.world().resource::<WorldCameraPreviews>().cards["camera-node"].sprite;
        assert!(app.world().get::<Camera>(preview_camera).unwrap().is_active);
        app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].texture = true;
        app.update();
        assert!(!app.world().get::<Camera>(preview_camera).unwrap().is_active);
        assert_eq!(
            app.world().get::<Visibility>(preview_sprite),
            Some(&Visibility::Hidden)
        );

        let observer_pose =
            Transform::from_xyz(17.0, 29.0, 41.0).with_rotation(Quat::from_rotation_y(0.5));
        app.insert_resource(Time::<Real>::default());
        app.world_mut().spawn((
            crate::model3d::grid::ModelCanvasCamera,
            observer_pose,
            Projection::Orthographic(crate::isometric_grid::canvas_camera_projection()),
        ));

        // CPU/ECS check only: editing changes the preview lens and sprite placement,
        // while canonical pose and viewport remain unchanged. No GPU pixels sampled.
        let viewport = app.world().resource::<CurrentScene>().0.viewport.clone();
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .world_camera_edit = Some(
            serde_json::from_value(serde_json::json!({
                "nodeId": "camera-node", "camera": camera["worldCamera"].clone()
            }))
            .unwrap(),
        );
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .world_camera_edit
            .as_mut()
            .unwrap()
            .camera
            .position
            .u = 5.0;
        app.update();
        assert!(app.world().get::<Camera>(preview_camera).unwrap().is_active);
        let preview_camera =
            app.world().resource::<WorldCameraPreviews>().cards["camera-node"].camera;
        assert_eq!(
            *app.world().get::<Transform>(preview_camera).unwrap(),
            observer_pose
        );
        app.world_mut()
            .resource_mut::<Time<Real>>()
            .advance_by(std::time::Duration::from_millis(200));
        app.update();
        let midpoint = *app.world().get::<Transform>(preview_camera).unwrap();
        assert_ne!(midpoint, observer_pose);
        assert!(midpoint.translation.x > observer_pose.translation.x);
        app.world_mut()
            .resource_mut::<Time<Real>>()
            .advance_by(std::time::Duration::from_secs(1));
        app.update();
        let previews = app.world().resource::<WorldCameraPreviews>();
        let card = previews.cards.get("camera-node").unwrap();
        assert_eq!(
            app.world()
                .get::<Transform>(card.sprite)
                .unwrap()
                .translation
                .z,
            901.0
        );
        assert_eq!(
            app.world()
                .get::<Transform>(card.camera)
                .unwrap()
                .translation
                .x,
            5.0 * crate::protocol::UNITS_PER_METER as f32
        );
        assert!(previews.editor_backdrop.is_some());
        let layers = app.world().get::<RenderLayers>(card.camera).unwrap();
        assert!(layers.intersects(&RenderLayers::layer(EDITOR_GUIDE_LAYER)));
        assert!(!layers.intersects(&RenderLayers::layer(
            crate::world_camera::WORLD_CAMERA_GIZMO_LAYER
        )));
        assert_eq!(
            app.world().get::<RenderLayers>(backdrop_grid).unwrap(),
            &RenderLayers::layer(crate::world_camera::WORLD_CAMERA_GIZMO_LAYER)
        );
        let mesh_count = app.world().resource::<Assets<Mesh>>().len();
        assert_eq!(mesh_count, 2);
        assert_eq!(
            app.world().resource::<CurrentScene>().0.nodes[0]
                .world_camera
                .as_ref()
                .unwrap()
                .position
                .u,
            0.0
        );
        assert_eq!(
            app.world().resource::<CurrentScene>().0.viewport.x,
            viewport.x
        );
        // Output inspection only removes the editor guide layer. The canonical
        // camera and scene binding remain untouched.
        app.world_mut().resource_mut::<CurrentScene>().0.world_camera_edit.as_mut().unwrap().show_helpers = false;
        app.update();
        let card = &app.world().resource::<WorldCameraPreviews>().cards["camera-node"];
        assert!(!app.world().get::<RenderLayers>(card.camera).unwrap().intersects(&RenderLayers::layer(EDITOR_GUIDE_LAYER)));
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .world_camera_edit = None;
        app.update();
        let previews = app.world().resource::<WorldCameraPreviews>();
        let card = previews.cards.get("camera-node").unwrap();
        assert!(previews.editor_backdrop.is_none());
        assert!(
            !app.world()
                .get::<RenderLayers>(card.camera)
                .unwrap()
                .intersects(&RenderLayers::layer(EDITOR_GUIDE_LAYER))
        );
        assert_eq!(
            app.world().get::<RenderLayers>(backdrop_grid).unwrap(),
            &RenderLayers::layer(crate::preview_layers::GRID_LAYER)
        );
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 0);
        assert_eq!(
            app.world()
                .get::<Transform>(card.camera)
                .unwrap()
                .translation
                .x,
            0.0
        );
        assert!(
            app.world()
                .get::<Transform>(card.sprite)
                .unwrap()
                .translation
                .z
                < 900.0
        );
    }

    fn camera_scene(bound_instance_id: serde_json::Value) -> Scene {
        let camera = serde_json::json!({
            "id": "camera-node",
            "type": "node",
            "x": 100.0,
            "y": 120.0,
            "width": 248.0,
            "height": 156.0,
            "worldCamera": {
                "kind": "world-camera",
                "version": "shared-world-v1",
                "cameraId": "camera-1",
                "settingsVersion": "v1",
                "position": { "u": 0.0, "v": 0.0, "h": 6.928203230275509 },
                "rotation": [0.0, -0.229752920547361, 0.97324898946773, 0.0],
                "projection": {
                    "kind": "isometric",
                    "verticalSizeMeters": 8.0,
                    "nearMeters": 0.1,
                    "farMeters": 500.0
                },
                "captureMode": { "kind": "static" },
                "aspect": { "width": 16.0, "height": 9.0 },
                "boundInstanceId": bound_instance_id
            }
        });
        let node = serde_json::from_value(camera).unwrap();
        Scene {
            nodes: vec![node],
            ..Scene::default()
        }
    }

    fn run_sync(scene: Scene) -> App {
        let mut app = App::new();
        app.init_resource::<Assets<Image>>()
            .init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<crate::app::PreviewLayerPool>()
            .init_resource::<crate::world_camera_binding::WorldCameraBinding>()
            .init_resource::<crate::world_capture::ActiveWorldCapture>()
            .init_resource::<crate::model3d::ModelVisuals>()
            .insert_resource(CurrentScene(scene))
            .insert_resource(SurfaceState {
                size: Vec2::new(800.0, 600.0),
                pixel_ratio: 1.0,
            })
            .insert_resource(ThemeResource::default())
            .init_resource::<WorldCameraPreviews>()
            .add_systems(Update, sync);
        app.world_mut()
            .spawn((crate::isometric_grid::IsometricGrid, RenderLayers::layer(0)));
        app.update();
        app
    }

    fn preview_camera_layers(app: &App) -> RenderLayers {
        let camera = app.world().resource::<WorldCameraPreviews>().cards["camera-node"].camera;
        app.world()
            .get::<RenderLayers>(camera)
            .expect("preview camera layers")
            .clone()
    }

    #[test]
    fn unbound_camera_renders_the_whole_world_layer() {
        let app = run_sync(camera_scene(serde_json::Value::Null));
        assert!(preview_camera_layers(&app).intersects(&RenderLayers::layer(crate::world_camera_binding::WORLD_LAYER)));
        assert!(!preview_camera_layers(&app).intersects(&RenderLayers::layer(0)));
    }

    #[test]
    fn bound_camera_without_target_renders_nothing_not_the_world() {
        let app = run_sync(camera_scene(serde_json::json!("missing-instance")));
        let layers = preview_camera_layers(&app);
        assert_eq!(layers.iter().count(), 0, "缺目标必须渲染空层");
        assert!(!layers.intersects(&RenderLayers::layer(0)));
    }
}
