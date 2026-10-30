//! Film-set group subject projection for the transparent overview cache.
//!
//! 片场迁移为 group 后，缓存主体是 group 拥有的场景组合，而不是旧的 `composite-asset`
//! 呈现。这里只读取 accepted 场景里已有的 group 投影（徽标布局与 prepared model bounds），
//! 不重新遍历 mesh、不访问 payload 租约。

use crate::protocol::{FilmSetGroupPreparation, GraphNode, Scene};

use super::geometry::Bounds2d;

/// 可信 adapter 是否为该 group 声明了总览缓存。
pub(crate) fn declared(node: &GraphNode) -> bool {
    node.group
        .as_ref()
        .is_some_and(|group| group.overview_cache.is_some() && !group.collapsed)
}

/// 同一 owner 的片场组装配（bindings/ground/sceneTransform）；普通 group 为 `None`。
pub(crate) fn preparation<'a>(scene: &'a Scene, owner_id: &str) -> Option<&'a FilmSetGroupPreparation> {
    scene
        .film_set_groups
        .iter()
        .find(|group| group.owner_id == owner_id)
}

/// 必须在缓存发布前就绪的媒体平面数：可见、无诊断的图片/视频绑定。
pub(crate) fn declared_media(prep: Option<&FilmSetGroupPreparation>) -> usize {
    prep.map_or(0, |prep| {
        prep.bindings
            .iter()
            .filter(|binding| {
                binding.visible
                    && binding.diagnostic.is_none()
                    && matches!(binding.kind.as_str(), "image" | "video")
            })
            .count()
    })
}

fn union(bounds: &mut Bounds2d, min_x: f32, min_y: f32, max_x: f32, max_y: f32) {
    if [min_x, min_y, max_x, max_y]
        .iter()
        .all(|value| value.is_finite())
    {
        bounds.min_x = bounds.min_x.min(min_x);
        bounds.min_y = bounds.min_y.min(min_y);
        bounds.max_x = bounds.max_x.max(max_x);
        bounds.max_y = bounds.max_y.max(max_y);
    }
}

/// 缓存内容的画布空间包围盒：模型投影范围。
///
/// 媒体平面与模型共用同一条根链并落在 model bounds 附近；GPU 验收覆盖边缘裁切。缺失
/// prepared model bounds 时没有徽标范围，也就没有可缓存的稳定区域。
pub(crate) fn content_bounds(node: &GraphNode) -> Option<Bounds2d> {
    node.group.as_ref()?;
    let badge = crate::canvas_query::group_model::badge_rect(node)?;
    let mut bounds = Bounds2d {
        min_x: badge.x,
        min_y: badge.y,
        max_x: badge.x + badge.z,
        max_y: badge.y + badge.w,
    };
    if let Some(layout) = crate::canvas_query::group_model::for_node(node) {
        union(
            &mut bounds,
            layout.center.x - layout.radii.x,
            layout.center.y - layout.radii.y,
            layout.center.x + layout.radii.x,
            layout.center.y + layout.radii.y,
        );
    }
    bounds.valid().then_some(bounds)
}

/// 稳定像素输入的摘要：只覆盖会影响缓存画面、但不含绝对位置的 accepted 呈现字段。
pub(crate) fn presentation_fingerprint(node: &GraphNode, prep: Option<&FilmSetGroupPreparation>) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut feed = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x100000001b3);
    };
    let Some(group) = node.group.as_ref() else {
        return hash;
    };
    feed(group.geometry_quality.is_some() as u64);
    feed(group.overview_cache.is_some() as u64);
    if let Some(bounds) = group.model_bounds.as_ref() {
        for value in bounds.aabb.min.into_iter().chain(bounds.aabb.max) {
            feed(value.to_bits() as u64);
        }
        feed(bounds.extent.to_bits() as u64);
    }
    if let Some(model) = node.model.as_ref() {
        for byte in model.resource_key.as_bytes().iter().chain(model.signature.as_bytes()) {
            feed(u64::from(*byte));
        }
        for value in [
            model.placement.offset.x,
            model.placement.offset.y,
            model.placement.offset.z,
            model.placement.scale,
            model.placement.yaw,
        ] {
            feed(value.to_bits() as u64);
        }
    }
    if let Some(prep) = prep {
        feed(prep.bindings.len() as u64);
        for binding in &prep.bindings {
            for byte in binding
                .binding_id
                .as_bytes()
                .iter()
                .chain(binding.kind.as_bytes())
                .chain(binding.content_key.as_bytes())
            {
                feed(u64::from(*byte));
            }
            let t = &binding.transform;
            for value in [t.x, t.y, t.z, t.scale, t.yaw] {
                feed(value.to_bits() as u64);
            }
            feed(binding.visible as u64);
            feed(binding.diagnostic.is_some() as u64);
            feed(binding.aspect_ratio.to_bits() as u64);
        }
        if let Some(transform) = prep.scene_transform.as_ref() {
            for value in [transform.x, transform.y, transform.z, transform.scale, transform.yaw] {
                feed(value.to_bits() as u64);
            }
        }
        if let Some(ground) = prep.ground.as_ref() {
            for value in [ground.width, ground.depth] {
                feed(value.to_bits() as u64);
            }
        }
        if let Some(clip) = prep.active_clip.as_ref() {
            for byte in clip.as_bytes() {
                feed(u64::from(*byte));
            }
        }
    }
    hash
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
                "model":{{"sceneVersion":"woohaa-model-scene-ir-v2","resourceKey":"k","signature":"s","placement":{{"offset":{{"x":0,"y":0,"z":0}},"scale":1,"yaw":0}}}},
                "group":{{"title":"set","memberCount":2,"collapsed":false,
                    "modelBounds":{{"aabb":{{"min":[-1,-1,-1],"max":[1,1,1]}},"extent":2}}{declaration}}}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn declaration_is_required_and_collapsed_groups_stay_live() {
        assert!(!declared(&group(false)));
        assert!(declared(&group(true)));
        let mut collapsed = group(true);
        collapsed.group.as_mut().unwrap().collapsed = true;
        assert!(!declared(&collapsed));
    }

    #[test]
    fn bounds_follow_the_model_projection_but_ignore_absolute_position() {
        let first = content_bounds(&group(true)).unwrap();
        let mut moved = group(true);
        moved.x += 400.;
        moved.y += 120.;
        let second = content_bounds(&moved).unwrap();
        assert!((second.min_x - first.min_x - 400.).abs() < 0.01);
        assert!((second.min_y - first.min_y - 120.).abs() < 0.01);
        assert!(first.valid());
        assert!(first.max_y > 150., "badge extends below the group body");
        // 徽标中心固定在组结构底边下方 40 画布单位，与模型尺寸和组宽无关。
        assert!(((first.min_y + first.max_y) / 2. - 190.).abs() < 0.01);
        let mut wider = group(true);
        wider.width = 1200.;
        let wider_bounds = content_bounds(&wider).unwrap();
        assert!((wider_bounds.max_x - wider_bounds.min_x - (first.max_x - first.min_x)).abs() < 0.01,
            "a wider group body must not inflate cache resolution");
        assert!((wider_bounds.max_y - wider_bounds.min_y - (first.max_y - first.min_y)).abs() < 0.01,
            "a wider group body must not change the badge height");
    }

    #[test]
    fn fingerprint_tracks_media_local_placement_and_ignores_translation() {
        let prep: FilmSetGroupPreparation = serde_json::from_value(serde_json::json!({
            "schemaVersion":"woohaa-film-set-group-render-v1","ownerId":"film",
            "badgeOrigin":{"x":0,"y":0},
            "bindings":[{"bindingId":"a","sourceNodeId":"model-1","kind":"model3d",
                "contentKey":"key","transform":{"x":0,"y":0,"z":0,"yaw":0,"scale":1}}]
        }))
        .unwrap();
        let base = presentation_fingerprint(&group(true), Some(&prep));
        assert_eq!(
            base,
            presentation_fingerprint(&group(true), Some(&prep)),
            "same input is stable"
        );
        let mut moved = group(true);
        moved.x += 300.;
        assert_eq!(base, presentation_fingerprint(&moved, Some(&prep)));
        let mut shifted: FilmSetGroupPreparation = prep.clone();
        shifted.bindings[0].transform.x = 1.5;
        assert_ne!(base, presentation_fingerprint(&group(true), Some(&shifted)));
        assert_ne!(base, presentation_fingerprint(&group(false), Some(&prep)));
    }
}
