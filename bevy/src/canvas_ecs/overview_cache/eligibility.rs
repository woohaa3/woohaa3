//! Conservative accepted-layout eligibility for transparent overview composites.

use super::geometry::Bounds2d;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fallback {
    Undeclared,
    Hidden,
    Dynamic,
    Dependencies,
    Quality,
    Overlap,
    CompressedDepth,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Candidate<'a> {
    pub(crate) owner: &'a str,
    pub(crate) bounds: Bounds2d,
    pub(crate) declared: bool,
    pub(crate) visible: bool,
    pub(crate) dynamic: bool,
    pub(crate) dependencies_ready: bool,
    pub(crate) quality_supported: bool,
    pub(crate) depth_compressed: bool,
}

fn intersects(a: Bounds2d, b: Bounds2d) -> bool {
    a.min_x < b.max_x && b.min_x < a.max_x && a.min_y < b.max_y && b.min_y < a.max_y
}

/// Pure media owners do not need a synthetic model root; an owner with no subject at all
/// stays direct so the empty-placeholder layer is never captured into the texture.
pub(crate) fn dependencies_ready(
    has_model: bool,
    model_ready: bool,
    media_count: usize,
    media_ready: bool,
) -> bool {
    (has_model || media_count > 0)
        && (!has_model || model_ready)
        && (media_count == 0 || media_ready)
}

/// Color-only caching cannot reconstruct per-pixel interleaving with another root. Until
/// an overlap is proven equivalent, every member of that overlap remains direct.
pub(crate) fn classify(candidates: &[Candidate<'_>]) -> Vec<Result<(), Fallback>> {
    let mut sorted: Vec<_> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.visible && candidate.bounds.valid())
        .collect();
    sorted.sort_by(|(_, left), (_, right)| left.bounds.min_x.total_cmp(&right.bounds.min_x));
    let mut overlapped = vec![false; candidates.len()];
    for (position, (index, candidate)) in sorted.iter().enumerate() {
        for (other_index, other) in sorted.iter().skip(position + 1) {
            if other.bounds.min_x >= candidate.bounds.max_x {
                break;
            }
            if other.owner != candidate.owner && intersects(candidate.bounds, other.bounds) {
                overlapped[*index] = true;
                overlapped[*other_index] = true;
            }
        }
    }
    candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            if !candidate.declared {
                return Err(Fallback::Undeclared);
            }
            if !candidate.visible || !candidate.bounds.valid() {
                return Err(Fallback::Hidden);
            }
            if candidate.dynamic {
                return Err(Fallback::Dynamic);
            }
            if !candidate.dependencies_ready {
                return Err(Fallback::Dependencies);
            }
            if !candidate.quality_supported {
                return Err(Fallback::Quality);
            }
            if candidate.depth_compressed {
                return Err(Fallback::CompressedDepth);
            }
            if overlapped[index] {
                return Err(Fallback::Overlap);
            }
            Ok(())
        })
        .collect()
}

#[cfg(feature = "canvas-core")]
pub(crate) fn sync_overview_eligibility(
    scene: bevy::prelude::Res<crate::app::CurrentScene>,
    rig: bevy::prelude::Res<crate::app::FocusRig>,
    models: bevy::prelude::Res<crate::model3d::ModelVisuals>,
    media: bevy::prelude::Res<crate::model3d::film_set_media::FilmSetMediaVisuals>,
    materials: bevy::prelude::Res<bevy::prelude::Assets<bevy::prelude::StandardMaterial>>,
    images: bevy::prelude::Res<bevy::prelude::Assets<bevy::prelude::Image>>,
    mut owners: bevy::prelude::Query<(
        &crate::canvas_ecs::components::CanvasNodeId,
        &mut crate::canvas_ecs::components::OverviewCacheOwner,
    )>,
) {
    let tier_by_owner: std::collections::HashMap<String, bool> = owners
        .iter()
        .map(|(id, owner)| (id.0.clone(), owner.tier.is_some()))
        .collect();
    let focus_active = rig.active
        || rig.animating()
        || scene.0.model_focus.is_some()
        || scene.0.focus_transition.is_some()
        || scene.0.model_editor.is_some();
    let mut candidates = Vec::new();
    for node in &scene.0.nodes {
        if node.model.is_none() && node.group.is_none() {
            continue;
        }
        let base = crate::depth_order::screen_bounds(node);
        let base_bounds = Bounds2d {
            min_x: base.x,
            min_y: base.y,
            max_x: base.x + base.width,
            max_y: base.y + base.height,
        };
        let bounds = super::subject::content_bounds(node).unwrap_or(base_bounds);
        let prep = super::subject::preparation(&scene.0, &node.id);
        let declared_media = super::subject::declared_media(prep);
        let dynamic = focus_active
            || models.is_active_animated_model(&node.id)
            || node.busy
            || node.aggregate_run.as_ref().is_some_and(|run| run.active)
            || scene
                .0
                .animation_playback
                .as_ref()
                .is_some_and(|playback| playback.node_id == node.id);
        candidates.push(Candidate {
            owner: &node.id,
            bounds,
            declared: super::subject::declared(node),
            visible: !node.ghost,
            dynamic,
            dependencies_ready: dependencies_ready(
                node.model.is_some(),
                models.has_root(&node.id),
                declared_media,
                media.owner_dependencies_ready(&node.id, declared_media, &materials, &images),
            ),
            quality_supported: tier_by_owner
                .get(node.id.as_str())
                .copied()
                .unwrap_or(false),
            // All overlaps already fall back, including compressed clusters.
            depth_compressed: false,
        });
    }
    let decisions: std::collections::HashMap<_, _> = candidates
        .iter()
        .zip(classify(&candidates))
        .map(|(candidate, result)| (candidate.owner, result.err()))
        .collect();
    for (id, mut owner) in &mut owners {
        if !owner.enabled {
            continue;
        }
        let fallback = decisions
            .get(id.0.as_str())
            .copied()
            .flatten()
            .or_else(|| (!decisions.contains_key(id.0.as_str())).then_some(Fallback::Hidden));
        if owner.fallback != fallback {
            owner.fallback = fallback;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(owner: &str, x: f32) -> Candidate<'_> {
        Candidate {
            owner,
            bounds: Bounds2d {
                min_x: x,
                min_y: 0.,
                max_x: x + 10.,
                max_y: 10.,
            },
            declared: true,
            visible: true,
            dynamic: false,
            dependencies_ready: true,
            quality_supported: true,
            depth_compressed: false,
        }
    }

    #[test]
    fn overlap_falls_back_only_the_affected_cluster() {
        let roots = [candidate("a", 0.), candidate("b", 5.), candidate("c", 30.)];
        assert_eq!(
            classify(&roots),
            vec![Err(Fallback::Overlap), Err(Fallback::Overlap), Ok(())]
        );
        let separated = [candidate("a", 0.), candidate("b", 10.)];
        assert_eq!(classify(&separated), vec![Ok(()), Ok(())]);
    }

    #[test]
    fn overlapping_group_bodies_do_not_imply_overlapping_3d_subjects() {
        let node = |id: &str, x: f32| serde_json::from_value::<crate::protocol::GraphNode>(serde_json::json!({
            "id": id, "type": "group", "x": x, "y": 0, "width": 400, "height": 200,
            "group": { "title": "set", "memberCount": 1, "overviewCache": "transparent-world-v1",
                "modelBounds": { "aabb": { "min": [-1., -1., -1.], "max": [1., 1., 1.] }, "extent": 8. } },
            "model": { "resourceKey": "test:set", "signature": "set" }
        })).unwrap();
        let a = node("a", 0.);
        let b = node("b", 200.);
        let mut left = candidate("a", 0.);
        let mut right = candidate("b", 0.);
        left.bounds = super::super::subject::content_bounds(&a).unwrap();
        right.bounds = super::super::subject::content_bounds(&b).unwrap();
        assert_eq!(classify(&[left, right]), vec![Ok(()), Ok(())]);
    }

    #[test]
    fn dynamic_dependencies_and_compressed_depth_take_precedence() {
        let mut root = candidate("a", 0.);
        root.dynamic = true;
        assert_eq!(classify(&[root]), vec![Err(Fallback::Dynamic)]);
        root.dynamic = false;
        root.dependencies_ready = false;
        assert_eq!(classify(&[root]), vec![Err(Fallback::Dependencies)]);
        root.dependencies_ready = true;
        root.depth_compressed = true;
        assert_eq!(classify(&[root]), vec![Err(Fallback::CompressedDepth)]);
    }

    #[test]
    fn pure_media_requires_its_pixels_but_not_a_model_root() {
        assert!(!dependencies_ready(false, false, 0, true));
        assert!(!dependencies_ready(true, false, 0, true));
        assert!(!dependencies_ready(false, false, 1, false));
        assert!(dependencies_ready(false, false, 1, true));
        assert!(dependencies_ready(true, true, 0, false));
        assert!(!dependencies_ready(true, true, 1, false));
    }

    #[cfg(feature = "canvas-core")]
    #[test]
    fn focus_returns_accepted_owner_to_direct_eligibility() {
        use crate::{
            app::{CurrentScene, FocusRig},
            canvas_ecs::components::{CanvasNodeId, OverviewCacheOwner},
            model3d::{ModelVisuals, film_set_media::FilmSetMediaVisuals},
            protocol::{GraphNode, Scene},
        };
        use bevy::{ecs::system::RunSystemOnce, prelude::*};
        let node: GraphNode = serde_json::from_value(serde_json::json!({"id":"film","type":"group","x":0,"y":0,
            "width":200,"height":150,
            "group":{"title":"set","memberCount":1,"overviewCache":"transparent-world-v1"}})).unwrap();
        let mut world = World::new();
        world.insert_resource(CurrentScene(Scene {
            nodes: vec![node],
            ..Scene::default()
        }));
        world.insert_resource(FocusRig::default());
        world.init_resource::<ModelVisuals>();
        world.init_resource::<FilmSetMediaVisuals>();
        world.init_resource::<Assets<StandardMaterial>>();
        world.init_resource::<Assets<Image>>();
        let owner = world
            .spawn((
                CanvasNodeId("film".into()),
                OverviewCacheOwner {
                    enabled: true,
                    tier: Some(super::super::geometry::OverviewTier::T256),
                    ..Default::default()
                },
            ))
            .id();
        world.run_system_once(sync_overview_eligibility).unwrap();
        assert_eq!(
            world.get::<OverviewCacheOwner>(owner).unwrap().fallback,
            Some(Fallback::Dependencies)
        );
        world.resource_mut::<FocusRig>().active = true;
        world.run_system_once(sync_overview_eligibility).unwrap();
        assert_eq!(
            world.get::<OverviewCacheOwner>(owner).unwrap().fallback,
            Some(Fallback::Dynamic)
        );
    }
}
