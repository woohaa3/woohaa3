//! Retained, theme-aware ground scope outlines. Editor layer never enters camera captures.
use super::{CurrentScene, FrameFlags};
use crate::{
    canvas_query::layout,
    scope_visual::{ScopeStyle, ScopeVisuals},
    theme::ThemeResource,
};
use bevy::{camera::visibility::RenderLayers, light::NotShadowCaster, prelude::*};
use std::collections::{HashMap, HashSet};

#[derive(Component)]
pub(super) struct SceneAreaLine;
#[derive(Component)]
struct SceneAreaFill;
#[derive(Component)]
struct SceneAreaExecution;
struct AreaExecution {
    entities: Vec<Entity>,
    materials: Vec<Handle<StandardMaterial>>,
}
struct AreaVisual {
    // Each of four edges can split into two pieces around the nameplate, plus the fill.
    entities: [Entity; 9],
    border: Handle<StandardMaterial>,
    fill: Handle<StandardMaterial>,
    execution: Option<AreaExecution>,
}
#[derive(Default)]
pub(super) struct AreaLayer {
    cube: Option<Handle<Mesh>>,
    areas: HashMap<String, AreaVisual>,
    revision: u64,
    theme: String,
}

pub(super) fn sync_scene_areas(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene: Res<CurrentScene>,
    time: Res<Time>,
    theme: Res<ThemeResource>,
    scopes: Option<Res<ScopeVisuals>>,
    flags: Res<FrameFlags>,
    mut layer: Local<AreaLayer>,
) {
    let hidden = scene.0.model_focus.is_some()
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some();
    // Keep the original edges and fill; animate a bounded pool of short trail segments.
    let (execution_color, _) = crate::scope_visual::execution_border(&theme, time.elapsed_secs());
    if let Some(cube) = layer.cube.clone() {
        for area in &scene.0.scene_areas {
            if let Some(visual) = layer.areas.get_mut(&area.node_id) {
                let active = !hidden && scene.0.executing_scopes.contains(&area.node_id);
                if active {
                    if let Some(mut material) = materials.get_mut(&visual.border) {
                        material.base_color = rgb(execution_color);
                    }
                }
                sync_execution(&mut commands, &mut materials, &cube, visual, area,
                    &theme, time.elapsed_secs(), scene.0.viewport.zoom, active);
            }
        }
    }
    let revision = scopes.as_deref().map_or(0, |scopes| scopes.revision);
    if !flags.scene_received
        && !flags.camera_changed
        && !flags.theme_changed
        && layer.revision == revision
        && layer.theme == theme.fingerprint()
    {
        return;
    }
    layer.revision = revision;
    layer.theme = theme.fingerprint().to_owned();
    let mut seen = HashSet::new();
    if !hidden {
        let cube = layer
            .cube
            .get_or_insert_with(|| meshes.add(Cuboid::new(1.0, 1.0, 1.0)))
            .clone();
        for area in &scene.0.scene_areas {
            let b = &area.bounds;
            if ![b.min.u, b.min.v, b.max.u, b.max.v]
                .iter()
                .all(|v| v.is_finite())
                || b.min.u >= b.max.u
                || b.min.v >= b.max.v
            {
                continue;
            }
            seen.insert(area.node_id.clone());
            let style = scopes
                .as_deref()
                .map(|scopes| scopes.style(&scene.0, &theme, &area.node_id))
                .unwrap_or_else(|| ScopeStyle::for_node(&scene.0, &theme, &area.node_id));
            let visual = layer.areas.entry(area.node_id.clone()).or_insert_with(|| {
                let border = materials.add(StandardMaterial {
                    unlit: true,
                    ..default()
                });
                let fill = materials.add(StandardMaterial {
                    unlit: true,
                    alpha_mode: AlphaMode::Blend,
                    ..default()
                });
                let entities = std::array::from_fn(|i| {
                    let mut entity = commands.spawn((
                        Mesh3d(cube.clone()),
                        MeshMaterial3d(if i == 8 { fill.clone() } else { border.clone() }),
                        RenderLayers::from_layers(&[crate::world_camera::WORLD_CAMERA_GIZMO_LAYER, crate::world_camera_preview::EDITOR_GUIDE_LAYER]),
                        NotShadowCaster,
                    ));
                    if i == 8 {
                        entity.insert(SceneAreaFill);
                    } else {
                        entity.insert(SceneAreaLine);
                    }
                    entity.id()
                });
                AreaVisual {
                    entities,
                    border,
                    fill,
                    execution: None,
                }
            });
            if let Some(mut material) = materials.get_mut(&visual.border) {
                material.base_color = rgb(if scene.0.executing_scopes.contains(&area.node_id) { execution_color } else { style.border });
            }
            if let Some(mut material) = materials.get_mut(&visual.fill) {
                material.base_color = theme
                    .token_color("interactionAccent")
                    .with_alpha(style.tint);
            }
            let [x0, _, z0] = crate::protocol::world_to_renderer([b.min.u, b.min.v, 0.0]);
            let [x1, _, z1] = crate::protocol::world_to_renderer([b.max.u, b.max.v, 0.0]);
            let (x0, x1, z0, z1) = (x0 as f32, x1 as f32, z0 as f32, z1 as f32);
            let zoom = scene.0.viewport.zoom.max(0.01);
            // Match the current ground projection rather than assuming a fixed camera pitch.
            let width = ground_stroke_width(style.width, zoom);
            let label = layout::scene_area_label_geometry(area);
            let contour = label.as_ref().map(layout::scene_area_label_outline);
            // Include the full cuboid footprint and the nameplate's half-unit border.
            let padding = projected_stroke_padding(width);
            for (side, (a, b)) in [
                (Vec2::new(x0, z0), Vec2::new(x1, z0)),
                (Vec2::new(x0, z1), Vec2::new(x1, z1)),
                (Vec2::new(x0, z0), Vec2::new(x0, z1)),
                (Vec2::new(x1, z0), Vec2::new(x1, z1)),
            ]
            .into_iter()
            .enumerate()
            {
                let pieces = edge_outside_nameplate(a, b, contour.as_deref(), padding);
                for slot in 0..2 {
                    let entity = visual.entities[side + slot * 4];
                    let Some(&(start, end)) = pieces.get(slot) else {
                        commands.entity(entity).insert(Visibility::Hidden);
                        continue;
                    };
                    let center = (start + end) * 0.5;
                    let span = (end - start).abs();
                    commands.entity(entity).insert((
                        Transform::from_xyz(
                            center.x,
                            crate::scope_visual::GROUND_SCOPE_HEIGHT,
                            center.y,
                        )
                        .with_scale(Vec3::new(
                            span.x + width,
                            0.001,
                            span.y + width,
                        )),
                        Visibility::Inherited,
                    ));
                }
            }
            commands.entity(visual.entities[8]).insert((
                Transform::from_xyz((x0 + x1) / 2.0, 0.01, (z0 + z1) / 2.0).with_scale(Vec3::new(
                    x1 - x0,
                    0.001,
                    (z1 - z0).abs(),
                )),
                if style.tint > 0.0 {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
            ));
            sync_execution(&mut commands, &mut materials, &cube, visual, area,
                &theme, time.elapsed_secs(), zoom, scene.0.executing_scopes.contains(&area.node_id));
        }
    }
    layer.areas.retain(|id, visual| {
        if seen.contains(id) {
            return true;
        }
        for entity in visual.entities {
            commands.entity(entity).despawn();
        }
        materials.remove(visual.border.id());
        materials.remove(visual.fill.id());
        clear_execution(&mut commands, &mut materials, visual);
        false
    });
}

fn clear_execution(
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    visual: &mut AreaVisual,
) {
    if let Some(execution) = visual.execution.take() {
        for entity in execution.entities {
            commands.entity(entity).despawn();
        }
        for material in execution.materials {
            materials.remove(material.id());
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn sync_execution(
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    cube: &Handle<Mesh>,
    visual: &mut AreaVisual,
    area: &crate::protocol::SceneArea,
    theme: &ThemeResource,
    seconds: f32,
    zoom: f32,
    active: bool,
) {
    if !active {
        clear_execution(commands, materials, visual);
        return;
    }
    let execution = visual.execution.get_or_insert_with(|| {
        let palette: Vec<_> = (0..crate::scope_visual::EXECUTION_TRAIL_STEPS)
            .map(|_| {
                materials.add(StandardMaterial {
                    unlit: true,
                    ..default()
                })
            })
            .collect();
        // Each trail slice can cross a corner and the nameplate can split a segment in two.
        let entities = (0..4 * (crate::scope_visual::EXECUTION_TRAIL_STEPS + 4))
            .map(|_| {
                commands
                    .spawn((
                        Mesh3d(cube.clone()),
                        MeshMaterial3d(palette[0].clone()),
                        Transform::default(),
                        Visibility::Hidden,
                        SceneAreaExecution,
                        NotShadowCaster,
                        RenderLayers::from_layers(&[
                            crate::world_camera::WORLD_CAMERA_GIZMO_LAYER,
                            crate::world_camera_preview::EDITOR_GUIDE_LAYER,
                        ]),
                    ))
                    .id()
            })
            .collect();
        AreaExecution {
            entities,
            materials: palette,
        }
    });
    for (step, handle) in execution.materials.iter().enumerate() {
        if let Some(mut material) = materials.get_mut(handle) {
            material.base_color = rgb(crate::scope_visual::execution_trail_color(
                theme, seconds, step,
            ));
        }
    }
    let [x0, _, z0] =
        crate::protocol::world_to_renderer([area.bounds.min.u, area.bounds.min.v, 0.0]);
    let [x1, _, z1] =
        crate::protocol::world_to_renderer([area.bounds.max.u, area.bounds.max.v, 0.0]);
    let path = [
        Vec2::new(x0 as f32, z0 as f32),
        Vec2::new(x1 as f32, z0 as f32),
        Vec2::new(x1 as f32, z1 as f32),
        Vec2::new(x0 as f32, z1 as f32),
    ];
    let width = ground_stroke_width(3.0, zoom);
    let contour = layout::scene_area_label_geometry(area)
        .as_ref()
        .map(layout::scene_area_label_outline);
    let padding = projected_stroke_padding(width);
    let mut count = 0;
    for segment in crate::scope_visual::execution_trail(&path, seconds) {
        for (start, end) in
            edge_outside_nameplate(segment.start, segment.end, contour.as_deref(), padding)
        {
            let Some(entity) = execution.entities.get(count) else {
                break;
            };
            let center = (start + end) * 0.5;
            let span = (end - start).abs();
            commands.entity(*entity).insert((
                Transform::from_xyz(
                    center.x,
                    crate::scope_visual::GROUND_SCOPE_HEIGHT + 0.003,
                    center.y,
                )
                .with_scale(Vec3::new(span.x + width, 0.001, span.y + width)),
                MeshMaterial3d(execution.materials[segment.step].clone()),
                Visibility::Inherited,
            ));
            count += 1;
        }
    }
    for entity in &execution.entities[count..] {
        commands.entity(*entity).insert(Visibility::Hidden);
    }
}

/// Clip an actual ground edge against the shared convex nameplate contour.
/// Returned pieces remain in world X/Z; only the overlap test uses canvas projection.
fn edge_outside_nameplate(
    a: Vec2,
    b: Vec2,
    contour: Option<&[Vec2]>,
    padding: f32,
) -> Vec<(Vec2, Vec2)> {
    let Some(contour) = contour.filter(|points| points.len() >= 3) else {
        return vec![(a, b)];
    };
    let project = |point: Vec2| {
        let point = crate::isometric_grid::view_rotation() * Vec3::new(point.x, 0.0, point.y);
        Vec2::new(point.x, -point.y)
    };
    let start = project(a);
    let end = project(b);
    let mut enter = 0.0_f32;
    let mut exit = 1.0_f32;
    let winding = (0..contour.len())
        .map(|i| contour[i].perp_dot(contour[(i + 1) % contour.len()]))
        .sum::<f32>()
        .signum();
    for index in 0..contour.len() {
        let origin = contour[index];
        let normal = (contour[(index + 1) % contour.len()] - origin)
            .normalize_or_zero()
            .perp()
            * winding;
        let distance = normal.dot(start - origin) + padding;
        let delta = normal.dot(end - start);
        if delta.abs() < 1e-6 {
            if distance < 0.0 {
                return vec![(a, b)];
            }
        } else {
            let crossing = -distance / delta;
            if delta > 0.0 {
                enter = enter.max(crossing);
            } else {
                exit = exit.min(crossing);
            }
            if enter >= exit {
                return vec![(a, b)];
            }
        }
    }
    let mut pieces = Vec::with_capacity(2);
    if enter > 1e-5 {
        pieces.push((a, a.lerp(b, enter)));
    }
    if exit < 1.0 - 1e-5 {
        pieces.push((a.lerp(b, exit), b));
    }
    pieces
}

fn projected_stroke_padding(width: f32) -> f32 {
    let rotation = crate::isometric_grid::view_rotation();
    [Vec3::new(width, 0.0, width), Vec3::new(width, 0.0, -width)]
        .map(|corner| (rotation * (corner * 0.5)).truncate().length())
        .into_iter()
        .fold(0.0_f32, f32::max)
        + (rotation * Vec3::Y * 0.0005).truncate().length()
        + 0.5
}

fn ground_stroke_width(pixels: f32, zoom: f32) -> f32 {
    let rotation = crate::isometric_grid::view_rotation();
    let x = (rotation * Vec3::X).truncate();
    let z = (rotation * Vec3::Z).truncate();
    pixels * x.length() / (zoom.max(0.01) * x.perp_dot(z).abs().max(0.001))
}

fn rgb(color: u32) -> Color {
    Color::srgb_u8((color >> 16) as u8, (color >> 8) as u8, color as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_animates_retained_border_and_trails_and_restores_after_stop() {
        let scene = crate::protocol::Scene {
            scene_areas: vec![serde_json::from_value(serde_json::json!({
                "nodeId":"area", "title":"Area", "bounds":{
                "min":{"u":-2,"v":-2},"max":{"u":2,"v":2}}
            })).unwrap()],
            executing_scopes: vec!["area".into()],
            ..default()
        };
        let mut app = App::new();
        app.insert_resource(CurrentScene(scene))
            .insert_resource(Time::<()>::default())
            .insert_resource(FrameFlags { scene_received: true, ..default() })
            .init_resource::<ThemeResource>()
            .init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .add_systems(Update, sync_scene_areas);
        app.update();
        let (entity, handle, transform) = app.world_mut()
            .query_filtered::<(Entity, &MeshMaterial3d<StandardMaterial>, &Transform), With<SceneAreaLine>>()
            .iter(app.world()).next().map(|(e, h, t)| (e, h.0.clone(), *t)).unwrap();
        let before = app.world().resource::<Assets<StandardMaterial>>().get(&handle).unwrap().base_color;
        let trail_before: Vec<_> = app.world_mut().query_filtered::<(Entity, &Transform), With<SceneAreaExecution>>()
            .iter(app.world()).map(|(entity, transform)| (entity, *transform)).collect();
        assert!(!trail_before.is_empty());
        app.world_mut().resource_mut::<FrameFlags>().scene_received = false;
        app.world_mut().resource_mut::<Time>().advance_by(std::time::Duration::from_millis(900));
        app.update();
        let after = app.world().resource::<Assets<StandardMaterial>>().get(&handle).unwrap().base_color;
        assert_ne!(before, after);
        assert_eq!(*app.world().get::<Transform>(entity).unwrap(), transform);
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
        assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 2 + crate::scope_visual::EXECUTION_TRAIL_STEPS);
        assert!(trail_before.iter().any(|(entity, transform)| app.world().get::<Transform>(*entity) != Some(transform)),
            "retained trail segments must move without a scene update");
        app.world_mut().resource_mut::<CurrentScene>().0.executing_scopes.clear();
        app.world_mut().resource_mut::<FrameFlags>().scene_received = true;
        app.update();
        let expected = app.world().resource::<ThemeResource>().token_u32("canvasEdgeDefault");
        assert_eq!(app.world().resource::<Assets<StandardMaterial>>().get(&handle).unwrap().base_color, rgb(expected));
        assert_eq!(app.world_mut().query_filtered::<Entity, With<SceneAreaExecution>>().iter(app.world()).count(), 0);
        assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 2);
    }

    #[test]
    fn scene_area_edges_exclude_the_full_nameplate_at_every_stroke_width() {
        let area: crate::protocol::SceneArea = serde_json::from_value(serde_json::json!({
            "nodeId":"area", "bounds":{"min":{"u":0,"v":0},"max":{"u":3,"v":3}}
        }))
        .unwrap();
        let label = layout::scene_area_label_geometry(&area).unwrap();
        let contour = layout::scene_area_label_outline(&label);
        let rotation = crate::isometric_grid::view_rotation();
        let project = |point: Vec2| {
            let point = rotation * Vec3::new(point.x, 0.0, point.y);
            Vec2::new(point.x, -point.y)
        };
        for zoom in [0.1, 0.25, 1.0, 8.0, 12.0] {
            for pixels in [1.25, 1.5, 2.0, 3.0] {
                let width = ground_stroke_width(pixels, zoom);
                let padding = projected_stroke_padding(width);
                let mut count = 0;
                for (a, b) in [
                    (Vec2::new(0.0, 0.0), Vec2::new(192.0, 0.0)),
                    (Vec2::new(0.0, -192.0), Vec2::new(192.0, -192.0)),
                    (Vec2::new(0.0, 0.0), Vec2::new(0.0, -192.0)),
                    (Vec2::new(192.0, 0.0), Vec2::new(192.0, -192.0)),
                ] {
                    let pieces = edge_outside_nameplate(a, b, Some(&contour), padding);
                    count += pieces.len();
                    for (start, end) in pieces {
                        for t in [0.0, 0.5, 1.0] {
                            for x in [-0.5, 0.5] {
                                for z in [-0.5, 0.5] {
                                    let corner =
                                        project(start.lerp(end, t) + Vec2::new(x, z) * width);
                                    let inside = (0..contour.len()).all(|i| {
                                        let normal = (contour[(i + 1) % contour.len()]
                                            - contour[i])
                                            .normalize()
                                            .perp();
                                        normal.dot(corner - contour[i]) >= -0.499
                                    });
                                    assert!(
                                        !inside,
                                        "line cuboid enters nameplate: zoom={zoom}, width={pixels}"
                                    );
                                }
                            }
                        }
                    }
                }
                if zoom == 1.0 {
                    assert_eq!(count, 5);
                }
            }
        }
    }

    #[test]
    fn scene_area_clip_handles_reversed_contours_and_whole_edge_removal() {
        let contour = vec![
            Vec2::new(-10.0, -10.0),
            Vec2::new(10.0, -10.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(-10.0, 10.0),
        ];
        let a = Vec2::new(-100.0, 0.0);
        let b = Vec2::new(100.0, 0.0);
        let pieces = edge_outside_nameplate(a, b, Some(&contour), 0.5);
        assert_eq!(pieces.len(), 2);
        let reversed: Vec<_> = contour.iter().copied().rev().collect();
        assert_eq!(pieces, edge_outside_nameplate(a, b, Some(&reversed), 0.5));
        assert!(
            edge_outside_nameplate(
                Vec2::new(-1.0, 0.0),
                Vec2::new(1.0, 0.0),
                Some(&contour),
                0.5
            )
            .is_empty()
        );
        assert_eq!(edge_outside_nameplate(a, b, None, 0.5), vec![(a, b)]);
    }

    #[test]
    fn scope_states_retain_entities_follow_theme_and_release_materials() {
        let mut app = App::new();
        app.init_resource::<Time>()
            .init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<CurrentScene>()
            .init_resource::<ThemeResource>()
            .insert_resource(FrameFlags {
                scene_received: true,
                ..default()
            })
            .add_systems(Update, sync_scene_areas);
        app.world_mut().resource_mut::<CurrentScene>().0.scene_areas = serde_json::from_value(
            serde_json::json!([{"nodeId":"a","bounds":{"min":{"u":0,"v":0},"max":{"u":3,"v":3}}}]),
        )
        .unwrap();
        app.update();
        let world = app.world_mut();
        let (id, material, normal_width) = world.query_filtered::<(Entity, &MeshMaterial3d<StandardMaterial>, &Transform), With<SceneAreaLine>>()
            .iter(world).map(|(entity, material, transform)| (entity, material.0.clone(), transform.scale.z)).next().unwrap();
        assert_eq!(
            world
                .resource::<Assets<StandardMaterial>>()
                .get(&material)
                .unwrap()
                .base_color,
            world
                .resource::<ThemeResource>()
                .token_color("canvasEdgeDefault")
        );
        assert_eq!(
            *world
                .query_filtered::<&Visibility, With<SceneAreaFill>>()
                .single(world)
                .unwrap(),
            Visibility::Hidden
        );
        world.resource_mut::<CurrentScene>().0.hover =
            Some(serde_json::from_value(serde_json::json!({"nodeId":"a"})).unwrap());
        app.update();
        let world = app.world_mut();
        assert!(world.get::<Transform>(id).unwrap().scale.z > normal_width);
        assert_eq!(
            *world
                .query_filtered::<&Visibility, With<SceneAreaFill>>()
                .single(world)
                .unwrap(),
            Visibility::Inherited
        );
        world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["a".into()];
        world
            .resource_mut::<ThemeResource>()
            .0
            .tokens
            .insert("canvasNodeBorderSelected".into(), "#123456".into());
        app.update();
        let world = app.world_mut();
        assert_eq!(
            world.get::<MeshMaterial3d<StandardMaterial>>(id).unwrap().0,
            material
        );
        assert_eq!(
            world
                .resource::<Assets<StandardMaterial>>()
                .get(&material)
                .unwrap()
                .base_color,
            Color::srgb_u8(0x12, 0x34, 0x56)
        );
        world.resource_mut::<CurrentScene>().0.scene_areas.clear();
        app.update();
        let world = app.world_mut();
        assert!(world.get_entity(id).is_err());
        assert_eq!(world.resource::<Assets<StandardMaterial>>().len(), 0);
    }
}
