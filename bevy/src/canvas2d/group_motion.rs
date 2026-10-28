//! Only visible, active creation groups animate. The container/card caches remain untouched.
use super::{Visuals, geometry::Geometry, group, group_outline};
use crate::{
    app::{CurrentScene, SurfaceState},
    protocol::GraphNode,
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

#[derive(Default)]
pub(crate) struct GroupMotion {
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    last_frame: Option<u64>,
}

pub(super) fn visible(node: &GraphNode, scene: &crate::protocol::Scene, size: Vec2) -> bool {
    let v = &scene.viewport;
    let bottom = node.y + node.height + crate::canvas_query::group_model::badge_outset(node);
    node.x * v.zoom + v.x <= size.x
        && (node.x + node.width) * v.zoom + v.x >= 0.
        && node.y * v.zoom + v.y <= size.y
        && bottom * v.zoom + v.y >= 0.
}

/// Two short strokes circulate at a steady screen-space speed, rather than suggesting a percentage.
pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    now: f32,
    zoom: f32,
    z: f32,
) {
    let path = group_outline::path(node);
    let perimeter = group_outline::length(&path);
    let zoom = zoom.max(0.1);
    let span = (100. / zoom).clamp(72., 200.).min(perimeter * 0.22);
    let head = (now * 95. / zoom).rem_euclid(perimeter);
    let accent = theme.token_u32("interactionAccent");
    let soft = theme.token_u32("interactionAccentSoft");
    for opposite in [0., perimeter / 2.] {
        for step in 0..16 {
            let t = (step + 1) as f32 / 16.;
            let color = mix(soft, accent, t);
            group_outline::stroke(
                geometry,
                &path,
                head + opposite - span + step as f32 * span / 16.,
                span / 16. + 0.2,
                (2.8 / zoom).clamp(2.2, 7.),
                z + 0.025,
                color,
            );
        }
    }
    if let Some((x, y, _, h)) = crate::canvas_query::layout::group_run_status_rect(node) {
        geometry.loading_ring(
            Vec2::new(x + 11., y + h / 2.),
            4.2,
            now * 3.2,
            accent,
            soft,
            z + 0.045,
        );
    }
}

pub(super) fn mix(a: u32, b: u32, t: f32) -> u32 {
    let mut result = 0;
    for shift in [0, 8, 16] {
        let x = ((a >> shift) & 255) as f32;
        let y = ((b >> shift) & 255) as f32;
        result |= ((x + (y - x) * t).round() as u32) << shift;
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    time: Res<Time>,
    theme: Res<ThemeResource>,
    visuals: Res<Visuals>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut state: Local<GroupMotion>,
) {
    let focused =
        super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some();
    let nodes: Vec<_> = scene
        .0
        .nodes
        .iter()
        .filter(|n| !focused && group::is_running(n) && visible(n, &scene.0, surface.size))
        .collect();
    if nodes.is_empty() {
        if let Some(entity) = state.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = state.mesh.take() {
            meshes.remove(mesh.id());
        }
        state.last_frame = None;
        return;
    }
    // Animation-only frames update at 30 Hz; scene/camera changes stay immediate.
    let frame = (time.elapsed_secs_f64() * 30.).floor() as u64;
    if state.last_frame == Some(frame)
        && !scene.is_changed()
        && !surface.is_changed()
        && !theme.is_changed()
    {
        return;
    }
    state.last_frame = Some(frame);
    let mut geometry = Geometry::default();
    for node in nodes {
        // Same derived slot as the group panel and its member cards, so the travelling
        // outline stays at its own group's z slot.
        let z = scene
            .0
            .nodes
            .iter()
            .position(|entry| entry.id == node.id)
            .map(|index| super::draw_order::render_z(&scene.0.nodes, index))
            .unwrap_or(group::GROUP_Z);
        draw(
            &mut geometry,
            &theme,
            node,
            time.elapsed_secs(),
            scene.0.viewport.zoom,
            z,
        );
    }
    let mesh = meshes.add(geometry.build());
    if let Some(old) = state.mesh.replace(mesh.clone()) {
        meshes.remove(old.id());
    }
    if let Some(entity) = state.entity {
        commands.entity(entity).insert(Mesh2d(mesh));
    } else {
        state.entity = Some(
            commands
                .spawn((
                    Mesh2d(mesh),
                    MeshMaterial2d(visuals.material.clone()),
                    Transform::default(),
                    NoFrustumCulling,
                ))
                .id(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::mesh::VertexAttributeValues;

    fn node(state: &str) -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id":"g", "type":"group", "x":100., "y":80., "width":600., "height":360.,
            "group":{"title":"Canvas", "memberCount":2, "outputCapableLeafCount":0,
                "runStatus":{"state":state,"label":"Running"}}
        }))
        .unwrap()
    }

    #[test]
    fn motion_changes_over_time_and_stays_at_group_perimeter_below_cards() {
        let theme = ThemeResource::default();
        let group = node("running");
        let positions = |now| {
            let mut geometry = Geometry::default();
            draw(&mut geometry, &theme, &group, now, 1., group::GROUP_Z);
            match geometry
                .build()
                .attribute(Mesh::ATTRIBUTE_POSITION)
                .unwrap()
            {
                VertexAttributeValues::Float32x3(p) => p.clone(),
                _ => panic!("unexpected position format"),
            }
        };
        let first = positions(0.);
        let next = positions(0.5);
        assert_ne!(first, next);
        for p in first.iter().chain(&next) {
            assert!(p[0] >= 96. && p[0] <= 704. && -p[1] >= 76. && -p[1] <= 444.);
            assert!(
                p[2] < 10.,
                "creation decoration must remain below member cards"
            );
        }
    }

    #[test]
    fn terminal_and_unconfirmed_runs_do_not_animate_and_culling_follows_viewport() {
        for state in ["queued", "running", "committing"] {
            assert!(group::is_running(&node(state)));
        }
        for state in ["succeeded", "failed", "cancelled", "unknown", "partial"] {
            assert!(!group::is_running(&node(state)));
        }
        let mut scene = crate::protocol::Scene::default();
        assert!(visible(&node("running"), &scene, Vec2::new(1024., 768.)));
        scene.viewport.x = -1000.;
        assert!(!visible(&node("running"), &scene, Vec2::new(1024., 768.)));
    }

    #[test]
    fn wrapped_strokes_never_draw_a_diagonal_across_the_group() {
        let group = node("running");
        let path = group_outline::path(&group);
        let perimeter = group_outline::length(&path);
        let mut geometry = Geometry::default();
        group_outline::stroke(&mut geometry, &path, perimeter - 20., 80., 3., 1., 0xffffff);
        let mesh = geometry.build();
        let VertexAttributeValues::Float32x3(p) = mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
        else {
            panic!()
        };
        for vertex in p {
            let x = vertex[0];
            let y = -vertex[1];
            assert!(
                (x - group.x).abs() < 14.
                    || (x - group.x - group.width).abs() < 14.
                    || (y - group.y).abs() < 14.
                    || (y - group.y - group.height).abs() < 14.
            );
        }
    }
}
