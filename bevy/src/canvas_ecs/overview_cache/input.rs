//! Pixel input projection after model and media updates have settled for this frame.

use bevy::prelude::*;

use crate::{
    app::{CurrentScene, NodeIndex, SurfaceState},
    canvas_ecs::components::{CanvasNodeId, OverviewCacheOwner},
    model3d::{ModelVisuals, film_set_media::FilmSetMediaVisuals},
    protocol::{FilmSetGroupPreparation, GraphNode},
    theme::ThemeResource,
};

fn append(hash: &mut u64, bytes: &[u8]) {
    for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
        *hash = (*hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
}

pub(super) fn pixel_fingerprint(
    node: &GraphNode,
    prep: Option<&FilmSetGroupPreparation>,
    quality: &str,
    media_revision: u64,
    theme: &str,
    tier: Option<super::geometry::OverviewTier>,
) -> Option<u64> {
    if !super::subject::declared(node) {
        return None;
    }
    let mut hash = super::subject::presentation_fingerprint(node, prep);
    append(&mut hash, quality.as_bytes());
    append(&mut hash, &media_revision.to_le_bytes());
    append(&mut hash, theme.as_bytes());
    append(&mut hash, &tier.map_or(0, |tier| tier.edge()).to_le_bytes());
    Some(hash)
}

pub(crate) fn sync_overview_inputs(
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    models: Res<ModelVisuals>,
    media: Res<FilmSetMediaVisuals>,
    theme: Res<ThemeResource>,
    surface: Res<SurfaceState>,
    mut owners: Query<(&CanvasNodeId, &mut OverviewCacheOwner)>,
) {
    for (id, mut owner) in &mut owners {
        if !owner.enabled {
            continue;
        }
        let Some((_, node)) = index.node(&scene.0, &id.0) else {
            continue;
        };
        let prep = super::subject::preparation(&scene.0, &id.0);
        let bounds = super::subject::content_bounds(node);
        let edge = bounds.map_or(0., |bounds| {
            (bounds.max_x - bounds.min_x).max(bounds.max_y - bounds.min_y)
        }) * scene.0.viewport.zoom
            * surface.pixel_ratio;
        let tier = super::geometry::tier_for_edge(edge, owner.tier);
        let Some(fingerprint) = pixel_fingerprint(
            node,
            prep,
            &models.quality_identity(&id.0),
            media.texture_revision(&id.0),
            theme.fingerprint(),
            tier,
        ) else {
            continue;
        };
        if owner.tier != tier {
            owner.tier = tier;
        }
        if owner.input_fingerprint != fingerprint {
            owner.input_fingerprint = fingerprint;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(overview: bool) -> GraphNode {
        let declaration = if overview {
            r#","overviewCache":"transparent-world-v1""#
        } else {
            ""
        };
        serde_json::from_str(&format!(
            r#"{{"id":"film","type":"group","x":0,"y":0,"width":200,"height":150,
                "group":{{"title":"set","memberCount":2,"collapsed":false{declaration}}}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn fingerprint_ignores_translation_and_tracks_pixel_dependencies() {
        let tier = Some(super::super::geometry::OverviewTier::T256);
        let first = pixel_fingerprint(&group(true), None, "Low:1", 1, "theme-a", tier).unwrap();
        let mut moved = group(true);
        moved.x += 300.;
        assert_eq!(
            first,
            pixel_fingerprint(&moved, None, "Low:1", 1, "theme-a", tier).unwrap()
        );
        assert_ne!(
            first,
            pixel_fingerprint(&group(true), None, "High:2", 1, "theme-a", tier).unwrap()
        );
        assert_ne!(
            first,
            pixel_fingerprint(&group(true), None, "Low:1", 2, "theme-a", tier).unwrap()
        );
        assert_ne!(
            first,
            pixel_fingerprint(&group(true), None, "Low:1", 1, "theme-b", tier).unwrap()
        );
        assert_ne!(
            first,
            pixel_fingerprint(
                &group(true),
                None,
                "Low:1",
                1,
                "theme-a",
                Some(super::super::geometry::OverviewTier::T512)
            )
            .unwrap()
        );
        assert!(
            pixel_fingerprint(&group(false), None, "Low:1", 1, "theme-a", tier).is_none(),
            "undeclared groups never cache"
        );
    }

    #[test]
    fn fingerprint_tracks_media_local_position() {
        let prep: FilmSetGroupPreparation = serde_json::from_value(serde_json::json!({
            "schemaVersion":"woohaa-film-set-group-render-v1","ownerId":"film",
            "badgeOrigin":{"x":0,"y":0},
            "bindings":[{"bindingId":"a","sourceNodeId":"image-1","kind":"image",
                "contentKey":"key","transform":{"x":0,"y":0,"z":0,"yaw":0,"scale":1}}]
        }))
        .unwrap();
        let fingerprint = |prep: &FilmSetGroupPreparation| {
            pixel_fingerprint(&group(true), Some(prep), "Low", 0, "theme", None).unwrap()
        };
        let first = fingerprint(&prep);
        for axis in 0..3 {
            let mut changed = prep.clone();
            let transform = &mut changed.bindings[0].transform;
            match axis {
                0 => transform.x += 1.,
                1 => transform.y += 1.,
                _ => transform.z += 1.,
            }
            assert_ne!(first, fingerprint(&changed));
        }
    }
}
